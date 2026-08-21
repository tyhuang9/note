use super::{assets, database, legacy_import, models::*};
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;
use std::{io::Write, path::Path};

/// These folders are real rows solely to satisfy the page foreign key. They
/// are not user folders and are filtered from the workspace DTO.
pub const ROOT_FOLDER_ID: &str = "";
pub const TEMPLATE_FOLDER_ID: &str = "__note_page_templates__";
const MAX_INK_POINTS: usize = 20_000;
const MAX_INK_PAYLOAD_BYTES: usize = 8 * 1024 * 1024;
const MAX_INK_LOCAL_COORDINATE: f64 = 1_000_000.0;
/// Shared with the frontend guard: every persisted or resolved world coordinate.
const MAX_CANVAS_VALUE: f64 = 1_000_000.0;
const MAX_CANVAS_ROTATION_DEGREES: f64 = 360.0;
const MAX_INK_BRUSH_SIZE: f64 = 512.0;
const MAX_SCENE_BATCH_BYTES: usize = 32 * 1024 * 1024;
const MAX_SCENE_BATCH_UPSERTS: usize = 5_000;
const MAX_SCENE_BATCH_DELETES: usize = 20_000;
const MAX_RICH_TEXT_BYTES: usize = 16 * 1024 * 1024;
const MAX_RICH_TEXT_DEPTH: usize = 64;
const MAX_RICH_TEXT_NODES: usize = 20_000;
const MAX_RICH_TEXT_PLAIN_BYTES: usize = 4 * 1024 * 1024;
const MAX_EMBEDDED_RICH_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_RICH_TEXT_ATTRIBUTE_BYTES: usize = 12 * 1024 * 1024;
const MIN_VISUAL_RECTANGLE_ROUNDNESS: f64 = 0.06;
const DIAMOND_CORNER_INSET: f64 = 0.08;
const RAY_INTERSECTION_TOLERANCE: f64 = 1e-12;

struct PayloadLimitWriter {
    bytes_written: usize,
    exceeded: bool,
    limit: usize,
}

impl Write for PayloadLimitWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        if buffer.len() > self.limit.saturating_sub(self.bytes_written) {
            self.exceeded = true;
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "ink payload size limit exceeded",
            ));
        }
        self.bytes_written += buffer.len();
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("element.{key} must be a non-empty string"))
}
fn finite(value: &Value, key: &str) -> Result<Option<f64>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(v) => v
            .as_f64()
            .filter(|n| n.is_finite())
            .map(Some)
            .ok_or_else(|| format!("element.{key} must be finite")),
    }
}

fn required_finite(value: &Value, key: &str, context: &str) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{context}.{key} must be a finite number"))
}

fn required_finite_object(
    value: &serde_json::Map<String, Value>,
    key: &str,
    context: &str,
) -> Result<f64, String> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{context}.{key} must be a finite number"))
}

fn validate_ink_color(color: &Value) -> Result<(), String> {
    let color = color
        .as_object()
        .ok_or("ink brush.color must be an object")?;
    match color.get("kind").and_then(Value::as_str) {
        Some("theme") => match color.get("token").and_then(Value::as_str) {
            Some("foreground" | "muted") => Ok(()),
            _ => Err("ink theme color token must be foreground or muted".into()),
        },
        Some("fixed") => {
            let value = color
                .get("value")
                .and_then(Value::as_str)
                .ok_or("ink fixed color.value must be a string")?;
            if matches!(value.len(), 7 | 9)
                && value.starts_with('#')
                && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                Ok(())
            } else {
                Err("ink fixed color must use #RRGGBB or #RRGGBBAA".into())
            }
        }
        _ => Err("ink brush.color kind must be theme or fixed".into()),
    }
}

fn validate_ink_element(value: &Value) -> Result<(), String> {
    let points = value
        .get("points")
        .and_then(Value::as_array)
        .ok_or("ink element.points must be an array")?;
    if points.is_empty() {
        return Err("ink element.points must contain at least one point".into());
    }
    if points.len() > MAX_INK_POINTS {
        return Err(format!(
            "ink element.points exceeds the {MAX_INK_POINTS} point limit"
        ));
    }
    let width = required_finite(value, "width", "ink element")?;
    let height = required_finite(value, "height", "ink element")?;
    for (index, point) in points.iter().enumerate() {
        let tuple = point
            .as_array()
            .filter(|tuple| tuple.len() == 3)
            .ok_or_else(|| format!("ink point {index} must be exactly [x, y, pressure]"))?;
        let coordinate = |position: usize, name: &str| {
            tuple[position]
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("ink point {index} {name} must be finite"))
        };
        let x = coordinate(0, "x")?;
        let y = coordinate(1, "y")?;
        let pressure = coordinate(2, "pressure")?;
        if !(0.0..=width.min(MAX_INK_LOCAL_COORDINATE)).contains(&x)
            || !(0.0..=height.min(MAX_INK_LOCAL_COORDINATE)).contains(&y)
        {
            return Err(format!(
                "ink point {index} coordinates must be local to the element and no greater than {MAX_INK_LOCAL_COORDINATE}"
            ));
        }
        if !(0.0..=1.0).contains(&pressure) {
            return Err(format!(
                "ink point {index} pressure must be between 0 and 1"
            ));
        }
    }

    let brush = value
        .get("brush")
        .and_then(Value::as_object)
        .ok_or("ink element.brush must be an object")?;
    if !matches!(
        brush.get("kind").and_then(Value::as_str),
        Some("pen" | "highlighter")
    ) {
        return Err("ink brush.kind must be pen or highlighter".into());
    }
    validate_ink_color(brush.get("color").ok_or("ink brush.color is required")?)?;
    let size = required_finite_object(brush, "size", "ink brush")?;
    if !(0.0 < size && size <= MAX_INK_BRUSH_SIZE) {
        return Err(format!(
            "ink brush.size must be greater than 0 and at most {MAX_INK_BRUSH_SIZE}"
        ));
    }
    for key in ["opacity", "smoothing", "streamline"] {
        let setting = required_finite_object(brush, key, "ink brush")?;
        if !(0.0..=1.0).contains(&setting) {
            return Err(format!("ink brush.{key} must be between 0 and 1"));
        }
    }
    let thinning = required_finite_object(brush, "thinning", "ink brush")?;
    if !(-1.0..=1.0).contains(&thinning) {
        return Err("ink brush.thinning must be between -1 and 1".into());
    }
    if brush
        .get("simulatePressure")
        .and_then(Value::as_bool)
        .is_none()
    {
        return Err("ink brush.simulatePressure must be boolean".into());
    }

    let mut writer = PayloadLimitWriter {
        bytes_written: 0,
        exceeded: false,
        limit: MAX_INK_PAYLOAD_BYTES,
    };
    if let Err(error) = serde_json::to_writer(&mut writer, value) {
        if writer.exceeded {
            return Err(format!(
                "ink element payload exceeds the {MAX_INK_PAYLOAD_BYTES} byte limit"
            ));
        }
        return Err(format!("ink element payload cannot be serialized: {error}"));
    }
    Ok(())
}

fn validate_primitive_style(value: &Value, context: &str) -> Result<(), String> {
    let Some(style) = value.get("style") else {
        return Ok(());
    };
    let style = style
        .as_object()
        .ok_or_else(|| format!("{context}.style must be an object"))?;
    if let Some(fill_color) = style.get("fillColor") {
        if !fill_color.is_null() {
            validate_ink_color(fill_color)?;
        }
    }
    if let Some(stroke_color) = style.get("strokeColor") {
        validate_ink_color(stroke_color)?;
    }
    for (key, min, max) in [
        ("roughness", 0.0, 10.0),
        ("roundness", 0.0, 1.0),
        ("strokeWidth", 0.0, 512.0),
    ] {
        if let Some(number) = style.get(key) {
            let number = number
                .as_f64()
                .filter(|number| number.is_finite())
                .ok_or_else(|| format!("{context}.style.{key} must be finite"))?;
            if !(min..=max).contains(&number) || (key == "strokeWidth" && number == 0.0) {
                return Err(format!("{context}.style.{key} is out of range"));
            }
        }
    }
    if let Some(seed) = style.get("seed") {
        if seed
            .as_u64()
            .filter(|seed| *seed <= u32::MAX as u64)
            .is_none()
        {
            return Err(format!(
                "{context}.style.seed must be an unsigned 32-bit integer"
            ));
        }
    }
    if let Some(stroke_style) = style.get("strokeStyle") {
        if !matches!(stroke_style.as_str(), Some("solid" | "dashed" | "dotted")) {
            return Err(format!("{context}.style.strokeStyle is invalid"));
        }
    }
    Ok(())
}

fn validate_shape_rich_text_value(value: &Value, context: &str) -> Result<(), String> {
    let value = value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))?;
    validate_known_keys(value, &["content", "richContent"], context)?;
    let content = value
        .get("content")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{context}.content must be a string"))?;
    if content.len() > MAX_RICH_TEXT_PLAIN_BYTES {
        return Err(format!(
            "{context}.content exceeds the {MAX_RICH_TEXT_PLAIN_BYTES} byte limit"
        ));
    }
    if let Some(rich_content) = value.get("richContent") {
        validate_rich_text_document(rich_content, &format!("{context}.richContent"))?;
    }
    Ok(())
}

fn validate_rich_text_document(value: &Value, context: &str) -> Result<(), String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("{context} cannot be serialized: {error}"))?;
    if bytes.len() > MAX_RICH_TEXT_BYTES {
        return Err(format!(
            "{context} exceeds the {MAX_RICH_TEXT_BYTES} byte limit"
        ));
    }
    if value.get("type").and_then(Value::as_str) != Some("doc") {
        return Err(format!("{context} root type must be doc"));
    }
    let mut totals = RichTextTotals::default();
    validate_rich_text_node(value, None, context, 0, &mut totals)
}

#[derive(Default)]
struct RichTextTotals {
    attribute_bytes: usize,
    node_count: usize,
    text_bytes: usize,
}

fn validate_rich_text_node(
    value: &Value,
    parent_type: Option<&str>,
    context: &str,
    depth: usize,
    totals: &mut RichTextTotals,
) -> Result<(), String> {
    if depth > MAX_RICH_TEXT_DEPTH {
        return Err(format!(
            "{context} exceeds the {MAX_RICH_TEXT_DEPTH} level depth limit"
        ));
    }
    totals.node_count += 1;
    if totals.node_count > MAX_RICH_TEXT_NODES {
        return Err(format!(
            "{context} exceeds the {MAX_RICH_TEXT_NODES} node limit"
        ));
    }
    let node = value
        .as_object()
        .ok_or_else(|| format!("{context} node must be an object"))?;
    let node_type = node
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{context}.type must be a string"))?;
    if !is_allowed_rich_text_child(parent_type, node_type) {
        return Err(format!(
            "{context}.type '{node_type}' is not supported here"
        ));
    }
    validate_known_keys(
        node,
        &["type", "attrs", "content", "marks", "text"],
        context,
    )?;
    validate_rich_text_node_attrs(node_type, node.get("attrs"), context)?;
    if let Some(attrs) = node.get("attrs") {
        totals.attribute_bytes += serde_json::to_vec(attrs)
            .map_err(|error| format!("{context}.attrs cannot be serialized: {error}"))?
            .len();
        if totals.attribute_bytes > MAX_RICH_TEXT_ATTRIBUTE_BYTES {
            return Err(format!(
                "{context}.attrs exceeds the aggregate attribute byte limit"
            ));
        }
    }
    if node_type == "text" {
        let text = node
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{context}.text must be a string"))?;
        if text.is_empty() {
            return Err(format!("{context}.text must not be empty"));
        }
        totals.text_bytes += text.len();
        if totals.text_bytes > MAX_RICH_TEXT_PLAIN_BYTES {
            return Err(format!(
                "{context}.text exceeds the aggregate text byte limit"
            ));
        }
        if node.get("content").is_some() {
            return Err(format!("{context}.content is not allowed"));
        }
    } else if node.get("text").is_some() {
        return Err(format!("{context}.text is only valid on text nodes"));
    }
    if let Some(marks) = node.get("marks") {
        if node_type != "text" {
            return Err(format!("{context}.marks is only valid on text nodes"));
        }
        let marks = marks
            .as_array()
            .ok_or_else(|| format!("{context}.marks must be an array"))?;
        if marks.len() > 32 {
            return Err(format!("{context}.marks exceeds the 32 mark limit"));
        }
        let mut mark_types = Vec::with_capacity(marks.len());
        for (index, mark) in marks.iter().enumerate() {
            validate_rich_text_mark(mark, &format!("{context}.marks[{index}]"))?;
            let mark_type = mark["type"].as_str().expect("validated mark type");
            if mark_types.contains(&mark_type) {
                return Err(format!("{context}.marks contains a duplicate mark"));
            }
            mark_types.push(mark_type);
            if let Some(attrs) = mark.get("attrs") {
                totals.attribute_bytes += serde_json::to_vec(attrs)
                    .map_err(|error| {
                        format!("{context}.marks[{index}].attrs cannot be serialized: {error}")
                    })?
                    .len();
                if totals.attribute_bytes > MAX_RICH_TEXT_ATTRIBUTE_BYTES {
                    return Err(format!(
                        "{context}.marks exceeds the aggregate attribute byte limit"
                    ));
                }
            }
        }
        if mark_types.contains(&"code") && mark_types.len() > 1 {
            return Err(format!(
                "{context}.marks cannot combine code with another mark"
            ));
        }
    }
    let leaf = matches!(node_type, "text" | "image" | "hardBreak" | "horizontalRule");
    if let Some(children) = node.get("content") {
        if leaf {
            return Err(format!("{context}.content is not allowed"));
        }
        let children = children
            .as_array()
            .ok_or_else(|| format!("{context}.content must be an array"))?;
        if matches!(
            node_type,
            "doc" | "blockquote" | "bulletList" | "orderedList"
        ) && children.is_empty()
        {
            return Err(format!("{context}.content must not be empty"));
        }
        if node_type == "listItem"
            && children
                .first()
                .and_then(|child| child.get("type"))
                .and_then(Value::as_str)
                != Some("paragraph")
        {
            return Err(format!("{context}.content must start with a paragraph"));
        }
        for (index, child) in children.iter().enumerate() {
            validate_rich_text_node(
                child,
                Some(node_type),
                &format!("{context}.content[{index}]"),
                depth + 1,
                totals,
            )?;
        }
    } else if matches!(
        node_type,
        "doc" | "blockquote" | "bulletList" | "orderedList" | "listItem"
    ) {
        return Err(format!("{context}.content must not be empty"));
    }
    Ok(())
}

fn is_allowed_rich_text_child(parent: Option<&str>, child: &str) -> bool {
    match parent {
        None => child == "doc",
        Some("doc" | "blockquote") => is_rich_text_block(child),
        Some("bulletList" | "orderedList") => child == "listItem",
        Some("listItem") => child == "paragraph" || is_rich_text_block(child),
        Some("paragraph" | "heading") => matches!(child, "text" | "hardBreak"),
        Some("codeBlock") => child == "text",
        _ => false,
    }
}

fn is_rich_text_block(node_type: &str) -> bool {
    matches!(
        node_type,
        "paragraph"
            | "heading"
            | "bulletList"
            | "orderedList"
            | "blockquote"
            | "codeBlock"
            | "horizontalRule"
            | "image"
    )
}

fn validate_known_keys(
    value: &serde_json::Map<String, Value>,
    allowed: &[&str],
    context: &str,
) -> Result<(), String> {
    if let Some(key) = value.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(format!("{context}.{key} is not supported"));
    }
    Ok(())
}

fn validate_rich_text_node_attrs(
    node_type: &str,
    attrs: Option<&Value>,
    context: &str,
) -> Result<(), String> {
    let attrs = match attrs {
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| format!("{context}.attrs must be an object"))?,
        ),
        None => None,
    };
    let allowed: &[&str] = match node_type {
        "heading" => &["level"],
        "orderedList" => &["start", "type"],
        "codeBlock" => &["language"],
        "image" => &["alt", "height", "src", "title", "width"],
        _ => &[],
    };
    if let Some(attrs) = attrs {
        validate_known_keys(attrs, allowed, &format!("{context}.attrs"))?;
    }
    match node_type {
        "heading" => {
            let level = attrs
                .and_then(|attrs| attrs.get("level"))
                .and_then(Value::as_u64);
            if !matches!(level, Some(1..=6)) {
                return Err(format!("{context}.attrs.level must be between 1 and 6"));
            }
        }
        "orderedList" => {
            if let Some(attrs) = attrs {
                if attrs
                    .get("start")
                    .is_some_and(|value| value.as_u64().filter(|start| *start > 0).is_none())
                {
                    return Err(format!("{context}.attrs.start must be a positive integer"));
                }
                if attrs
                    .get("type")
                    .is_some_and(|value| !value.is_null() && value.as_str().is_none())
                {
                    return Err(format!("{context}.attrs.type must be a string or null"));
                }
            }
        }
        "codeBlock" => {
            if attrs
                .and_then(|attrs| attrs.get("language"))
                .is_some_and(|value| {
                    !value.is_null() && value.as_str().is_none_or(|text| text.len() > 100)
                })
            {
                return Err(format!(
                    "{context}.attrs.language must be a bounded string or null"
                ));
            }
        }
        "image" => validate_rich_image_attrs(attrs, context)?,
        _ => {}
    }
    Ok(())
}

fn validate_rich_image_attrs(
    attrs: Option<&serde_json::Map<String, Value>>,
    context: &str,
) -> Result<(), String> {
    let attrs = attrs.ok_or_else(|| format!("{context}.attrs must be an object"))?;
    let src = attrs
        .get("src")
        .and_then(Value::as_str)
        .filter(|src| !src.is_empty())
        .ok_or_else(|| format!("{context}.attrs.src must be a non-empty string"))?;
    validate_rich_image_source(src, &format!("{context}.attrs.src"))?;
    for key in ["alt", "title"] {
        if attrs.get(key).is_some_and(|value| {
            !value.is_null() && value.as_str().is_none_or(|text| text.len() > 16_384)
        }) {
            return Err(format!("{context}.attrs.{key} must be a bounded string"));
        }
    }
    for key in ["width", "height"] {
        if let Some(value) = attrs.get(key) {
            if !value.is_null()
                && value
                    .as_f64()
                    .filter(|number| {
                        number.is_finite() && (0.0 < *number && *number <= MAX_CANVAS_VALUE)
                    })
                    .is_none()
            {
                return Err(format!(
                    "{context}.attrs.{key} must be a positive finite number"
                ));
            }
        }
    }
    Ok(())
}

fn validate_rich_image_source(src: &str, context: &str) -> Result<(), String> {
    let Some((header, payload)) = src.split_once(',') else {
        return Err(format!("{context} must use a supported raster data URL"));
    };
    if !matches!(
        header.to_ascii_lowercase().as_str(),
        "data:image/png;base64"
            | "data:image/jpeg;base64"
            | "data:image/gif;base64"
            | "data:image/webp;base64"
    ) {
        return Err(format!("{context} must use a supported raster data URL"));
    }
    let decoded = STANDARD
        .decode(payload)
        .map_err(|_| format!("{context} must contain valid base64"))?;
    if decoded.len() > MAX_EMBEDDED_RICH_IMAGE_BYTES {
        return Err(format!(
            "{context} exceeds the {MAX_EMBEDDED_RICH_IMAGE_BYTES} decoded byte limit"
        ));
    }
    Ok(())
}

fn is_safe_absolute_url(value: &str, prefixes: &[&str]) -> bool {
    value.len() <= 8_192
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
        && url::Url::parse(value)
            .ok()
            .is_some_and(|url| prefixes.contains(&url.scheme()))
}

fn validate_rich_text_mark(value: &Value, context: &str) -> Result<(), String> {
    let mark = value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))?;
    let mark_type = mark
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{context}.type must be a string"))?;
    if !matches!(
        mark_type,
        "bold" | "italic" | "strike" | "underline" | "code" | "textStyle" | "link"
    ) {
        return Err(format!("{context}.type '{mark_type}' is not supported"));
    }
    validate_known_keys(mark, &["type", "attrs"], context)?;
    let allowed_attrs: &[&str] = match mark_type {
        "textStyle" => &["fontFamily", "fontSize"],
        "link" => &["href", "target", "rel", "class", "title"],
        _ => &[],
    };
    let attrs = match mark.get("attrs") {
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| format!("{context}.attrs must be an object"))?,
        ),
        None => None,
    };
    if let Some(attrs) = attrs {
        validate_known_keys(attrs, allowed_attrs, &format!("{context}.attrs"))?;
    }
    if mark_type == "textStyle" {
        let attrs = attrs.ok_or_else(|| format!("{context}.attrs must be an object"))?;
        if attrs.get("fontFamily").is_some_and(|value| {
            !value.is_null() && value.as_str().is_none_or(|text| text.len() > 256)
        }) {
            return Err(format!(
                "{context}.attrs.fontFamily must be a bounded string or null"
            ));
        }
        if attrs.get("fontSize").is_some_and(|value| {
            !value.is_null() && value.as_str().is_none_or(|text| !is_safe_font_size(text))
        }) {
            return Err(format!(
                "{context}.attrs.fontSize must be between 8px and 96px or null"
            ));
        }
    }
    if mark_type == "link" {
        let attrs = attrs.ok_or_else(|| format!("{context}.attrs must be an object"))?;
        let href = attrs
            .get("href")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{context}.attrs.href must be a string"))?;
        if !is_safe_absolute_url(href, &["http", "https", "mailto", "tel"]) {
            return Err(format!("{context}.attrs.href uses an unsafe URL"));
        }
        for key in ["target", "rel", "class", "title"] {
            if attrs.get(key).is_some_and(|value| {
                !value.is_null() && value.as_str().is_none_or(|text| text.len() > 512)
            }) {
                return Err(format!(
                    "{context}.attrs.{key} must be a bounded string or null"
                ));
            }
        }
    }
    Ok(())
}

fn is_safe_font_size(value: &str) -> bool {
    let Some(number) = value
        .strip_suffix("px")
        .and_then(|number| number.parse::<u8>().ok())
    else {
        return false;
    };
    (8..=96).contains(&number) && value == format!("{number}px")
}

fn validate_connector_endpoint(value: &Value, context: &str) -> Result<(), String> {
    let endpoint = value
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))?;
    match endpoint.get("kind").and_then(Value::as_str) {
        Some("free") => {
            validate_known_keys(endpoint, &["kind", "x", "y"], context)?;
            let x = required_finite_object(endpoint, "x", context)?;
            let y = required_finite_object(endpoint, "y", context)?;
            validate_canvas_coordinate(x, &format!("{context}.x"))?;
            validate_canvas_coordinate(y, &format!("{context}.y"))?;
        }
        Some("element") => {
            validate_known_keys(
                endpoint,
                &["kind", "targetElementId", "anchor", "gap"],
                context,
            )?;
            let target = "targetElementId";
            let position = "anchor";
            endpoint
                .get(target)
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| format!("{context}.{target} must be a non-empty string"))?;
            if let Some(anchor) = endpoint.get("anchor") {
                validate_known_keys(
                    anchor
                        .as_object()
                        .ok_or_else(|| format!("{context}.{position} must be within 0 and 1"))?,
                    &["t"],
                    &format!("{context}.anchor"),
                )?;
                if anchor
                    .get("t")
                    .and_then(Value::as_f64)
                    .filter(|t| t.is_finite() && (0.0..=1.0).contains(t))
                    .is_none()
                {
                    return Err(format!("{context}.{position} must be within 0 and 1"));
                }
            }
            let gap = required_finite_object(endpoint, "gap", context)?;
            if !(0.0..=MAX_CANVAS_VALUE).contains(&gap) {
                return Err(format!(
                    "{context}.gap must be between 0 and {MAX_CANVAS_VALUE}"
                ));
            }
        }
        _ => return Err(format!("{context}.kind is invalid")),
    }
    Ok(())
}

fn validate_canvas_coordinate(value: f64, context: &str) -> Result<(), String> {
    if value.abs() > MAX_CANVAS_VALUE {
        return Err(format!(
            "{context} must be between -{MAX_CANVAS_VALUE} and {MAX_CANVAS_VALUE}"
        ));
    }
    Ok(())
}

fn validate_canvas_rotation(value: f64, context: &str) -> Result<(), String> {
    if value.abs() > MAX_CANVAS_ROTATION_DEGREES {
        return Err(format!(
            "{context} must be between -{MAX_CANVAS_ROTATION_DEGREES} and {MAX_CANVAS_ROTATION_DEGREES}"
        ));
    }
    Ok(())
}

fn validate_scene_batch(batch: &SceneChangeBatch) -> Result<(), String> {
    if batch.upserts.len() > MAX_SCENE_BATCH_UPSERTS {
        return Err(format!(
            "scene batch exceeds the {MAX_SCENE_BATCH_UPSERTS} upsert limit"
        ));
    }
    if batch.deleted_element_ids.len() > MAX_SCENE_BATCH_DELETES {
        return Err(format!(
            "scene batch exceeds the {MAX_SCENE_BATCH_DELETES} delete limit"
        ));
    }
    if batch.deleted_element_ids.iter().any(|id| id.is_empty()) {
        return Err("deleted element IDs must be non-empty".into());
    }
    let mut writer = PayloadLimitWriter {
        bytes_written: 0,
        exceeded: false,
        limit: MAX_SCENE_BATCH_BYTES,
    };
    for element in &batch.upserts {
        validate_element(element, &batch.page_id)?;
        if let Err(error) = serde_json::to_writer(&mut writer, element) {
            if writer.exceeded {
                return Err(format!(
                    "scene batch payload exceeds the {MAX_SCENE_BATCH_BYTES} byte limit"
                ));
            }
            return Err(format!("scene batch element cannot be serialized: {error}"));
        }
    }
    Ok(())
}
fn validate_element(value: &Value, page_id: &str) -> Result<(), String> {
    if !value.is_object() {
        return Err("element must be a JSON object".into());
    }
    required_string(value, "id")?;
    if required_string(value, "pageId")? != page_id {
        return Err("element pageId does not match batch pageId".into());
    }
    let kind = required_string(value, "type")?;
    if !matches!(kind, "text" | "image" | "ink" | "shape" | "connector") {
        return Err(format!("unsupported element type: {kind}"));
    }
    let opacity = finite(value, "opacity")?.ok_or("element.opacity is required")?;
    if !(0.0..=1.0).contains(&opacity) {
        return Err("element.opacity must be between 0 and 1".into());
    }
    for key in ["x", "y", "width", "height", "rotation"] {
        let v = finite(value, key)?;
        if matches!(key, "x" | "y") {
            if let Some(number) = v {
                validate_canvas_coordinate(number, &format!("element.{key}"))?;
            }
        }
        if key == "rotation" {
            if let Some(number) = v {
                validate_canvas_rotation(number, "element.rotation")?;
            }
        }
        if matches!(key, "width" | "height")
            && v.is_some_and(|number| !(0.0..=MAX_CANVAS_VALUE).contains(&number))
        {
            return Err(format!(
                "element.{key} must be between 0 and {MAX_CANVAS_VALUE}"
            ));
        }
    }
    for key in ["zIndex", "createdAt", "updatedAt"] {
        if value.get(key).and_then(Value::as_i64).is_none()
            && value
                .get(key)
                .and_then(Value::as_u64)
                .filter(|n| *n <= i64::MAX as u64)
                .is_none()
        {
            return Err(format!("element.{key} must be an integer"));
        }
    }
    if value.get("locked").and_then(Value::as_bool).is_none() {
        return Err("element.locked must be boolean".into());
    }
    if kind != "connector"
        && ["x", "y", "width", "height", "rotation"]
            .iter()
            .any(|k| value.get(*k).is_none())
    {
        return Err("box element geometry is incomplete".into());
    }
    match kind {
        "text" => {
            if value.get("content").and_then(Value::as_str).is_none() {
                return Err("text element.content must be a string".into());
            }
            if let Some(background_mode) = value.get("backgroundMode") {
                if !matches!(background_mode.as_str(), Some("surface" | "transparent")) {
                    return Err("text element.backgroundMode is invalid".into());
                }
            }
        }
        "image"
            if value
                .get("assetId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .is_none() =>
        {
            return Err("image element.assetId must be a non-empty string".into())
        }
        "ink" => validate_ink_element(value)?,
        "shape" => {
            if !matches!(
                value.get("shape").and_then(Value::as_str),
                Some("rectangle" | "ellipse" | "diamond")
            ) {
                return Err("shape element.shape is invalid".into());
            }
            validate_primitive_style(value, "shape")?;
            if let Some(text) = value.get("text") {
                validate_shape_rich_text_value(text, "shape element.text")?;
            }
        }
        "connector" => {
            validate_connector_endpoint(
                value.get("start").ok_or("connector.start is required")?,
                "connector.start",
            )?;
            validate_connector_endpoint(
                value.get("end").ok_or("connector.end is required")?,
                "connector.end",
            )?;
            if let Some(routing) = value.get("routing") {
                if routing.as_str() != Some("straight") {
                    return Err("connector.routing must be straight".into());
                }
            }
            validate_primitive_style(value, "connector")?;
            if let Some(style) = value.get("style").and_then(Value::as_object) {
                for key in ["startArrowhead", "endArrowhead"] {
                    if let Some(arrow) = style.get(key) {
                        if !matches!(arrow.as_str(), Some("none" | "arrow")) {
                            return Err(format!("connector.style.{key} is invalid"));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_final_connector_bindings(
    transaction: &Transaction<'_>,
    page_id: &str,
) -> Result<(), String> {
    let connectors = {
        let mut statement = transaction
            .prepare(
                "SELECT id,payload_json FROM elements WHERE page_id=? AND element_type='connector'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([page_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    for (connector_id, payload) in connectors {
        let connector: Value = serde_json::from_str(&payload).map_err(|error| {
            format!("connector {connector_id} has invalid stored payload: {error}")
        })?;
        let is_arrow = connector
            .get("style")
            .and_then(Value::as_object)
            .and_then(|style| style.get("endArrowhead"))
            .and_then(Value::as_str)
            == Some("arrow");
        let mut binding_targets = Vec::new();
        for endpoint_name in ["start", "end"] {
            let context = format!("connector {connector_id}.{endpoint_name}");
            let endpoint = connector
                .get(endpoint_name)
                .ok_or_else(|| format!("{context} is required"))?;
            validate_connector_endpoint(endpoint, &context)?;
            let Some(target_element_id) = endpoint
                .as_object()
                .filter(|endpoint| endpoint.get("kind").and_then(Value::as_str) == Some("element"))
                .and_then(|endpoint| endpoint.get("targetElementId"))
                .and_then(Value::as_str)
            else {
                continue;
            };
            if !is_arrow {
                return Err(format!(
                    "{context}.kind element is only supported for arrow connectors"
                ));
            }
            let target = validate_bound_connector_target(
                transaction,
                page_id,
                target_element_id,
                endpoint,
                &context,
            )?;
            if !binding_targets
                .iter()
                .any(|candidate: &ObjectBindingTarget| candidate.id == target.id)
            {
                binding_targets.push(target);
            }
        }
        if is_arrow {
            let start = object_binding_endpoint_from_value(
                connector
                    .get("start")
                    .ok_or("connector.start is required")?,
            )?;
            let end = object_binding_endpoint_from_value(
                connector.get("end").ok_or("connector.end is required")?,
            )?;
            let connector_stroke_width = connector
                .get("style")
                .and_then(Value::as_object)
                .and_then(|style| style.get("strokeWidth"))
                .and_then(Value::as_f64)
                .unwrap_or(2.0);
            if resolve_object_binding_points(
                &connector_id,
                connector_stroke_width,
                &start,
                &end,
                &binding_targets,
            )
            .is_none()
            {
                return Err(format!(
                    "connector {connector_id} has an invalid or same-target canonical binding"
                ));
            }
        }
    }
    Ok(())
}

fn validate_bound_connector_target(
    transaction: &Transaction<'_>,
    page_id: &str,
    target_element_id: &str,
    endpoint: &Value,
    context: &str,
) -> Result<ObjectBindingTarget, String> {
    let target: Option<(String, String, String)> = transaction
        .query_row(
            "SELECT page_id,element_type,payload_json FROM elements WHERE id=?",
            [target_element_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((target_page_id, target_type, target_payload)) = target else {
        return Err(format!(
            "{context}.targetElementId must reference an existing compatible element on this page"
        ));
    };
    if target_page_id != page_id {
        return Err(format!(
            "{context}.targetElementId must reference a compatible element on the same page"
        ));
    }
    if target_type != "shape" && target_type != "text" {
        return Err(format!(
            "{context}.targetElementId must reference a rectangle, ellipse, diamond, or text block"
        ));
    }
    let target: Value = serde_json::from_str(&target_payload).map_err(|error| {
        format!("{context}.targetElementId has invalid stored payload: {error}")
    })?;
    if target_type == "shape"
        && !matches!(
            target.get("shape").and_then(Value::as_str),
            Some("rectangle" | "ellipse" | "diamond")
        )
    {
        return Err(format!(
            "{context}.targetElementId must reference a rectangle, ellipse, diamond, or text block"
        ));
    }
    validate_bound_connector_resolution(&target, &target_type, endpoint, context)?;
    object_binding_target_from_value(&target, &target_type, target_element_id, context)
}

fn object_binding_endpoint_from_value(value: &Value) -> Result<ObjectBindingEndpoint, String> {
    match value.get("kind").and_then(Value::as_str) {
        Some("free") => Ok(ObjectBindingEndpoint::Free((
            value
                .get("x")
                .and_then(Value::as_f64)
                .ok_or("connector endpoint x is invalid")?,
            value
                .get("y")
                .and_then(Value::as_f64)
                .ok_or("connector endpoint y is invalid")?,
        ))),
        Some("element") => Ok(ObjectBindingEndpoint::Element {
            target_id: value
                .get("targetElementId")
                .and_then(Value::as_str)
                .ok_or("connector endpoint target is invalid")?
                .to_owned(),
            gap: value
                .get("gap")
                .and_then(Value::as_f64)
                .ok_or("connector endpoint gap is invalid")?,
            legacy_t: value
                .get("anchor")
                .and_then(Value::as_object)
                .and_then(|anchor| anchor.get("t"))
                .and_then(Value::as_f64),
        }),
        _ => Err("connector endpoint kind is invalid".into()),
    }
}

fn object_binding_target_from_value(
    target: &Value,
    target_type: &str,
    target_id: &str,
    context: &str,
) -> Result<ObjectBindingTarget, String> {
    let style = target.get("style").and_then(Value::as_object);
    Ok(ObjectBindingTarget {
        id: target_id.to_owned(),
        kind: target_type.to_owned(),
        shape: if target_type == "text" {
            "text".to_owned()
        } else {
            target
                .get("shape")
                .and_then(Value::as_str)
                .ok_or_else(|| format!("{context}.targetElementId has invalid shape payload"))?
                .to_owned()
        },
        x: required_finite(target, "x", context)?,
        y: required_finite(target, "y", context)?,
        width: required_finite(target, "width", context)?,
        height: required_finite(target, "height", context)?,
        rotation: required_finite(target, "rotation", context)?,
        roundness: style
            .and_then(|style| style.get("roundness"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        stroke_width: style
            .and_then(|style| style.get("strokeWidth"))
            .and_then(Value::as_f64)
            .unwrap_or(2.0),
    })
}

fn validate_bound_connector_resolution(
    target: &Value,
    target_type: &str,
    endpoint: &Value,
    context: &str,
) -> Result<(), String> {
    let shape = if target_type == "text" {
        "text"
    } else {
        target
            .get("shape")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{context}.targetElementId has invalid shape payload"))?
    };
    let x = required_finite(target, "x", context)?;
    let y = required_finite(target, "y", context)?;
    let width = required_finite(target, "width", context)?;
    let height = required_finite(target, "height", context)?;
    let rotation = required_finite(target, "rotation", context)?;
    validate_canvas_coordinate(x, &format!("{context}.targetElementId.x"))?;
    validate_canvas_coordinate(y, &format!("{context}.targetElementId.y"))?;
    if !(0.0..=MAX_CANVAS_VALUE).contains(&width) || !(0.0..=MAX_CANVAS_VALUE).contains(&height) {
        return Err(format!("{context}.targetElementId has invalid dimensions"));
    }
    validate_canvas_rotation(rotation, &format!("{context}.targetElementId.rotation"))?;
    let roundness = if target_type == "shape" && shape == "rectangle" {
        target
            .get("style")
            .and_then(Value::as_object)
            .and_then(|style| style.get("roundness"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
    } else {
        0.0
    };

    let endpoint = endpoint
        .as_object()
        .ok_or_else(|| format!("{context} must be an object"))?;
    let gap = required_finite_object(endpoint, "gap", context)?;
    if let Some(t) = endpoint
        .get("anchor")
        .and_then(Value::as_object)
        .and_then(|anchor| anchor.get("t"))
        .and_then(Value::as_f64)
    {
        let resolved =
            resolve_shape_anchor(shape, x, y, width, height, rotation, roundness, t, gap)
                .ok_or_else(|| format!("{context} resolves to an invalid point"))?;
        validate_canvas_coordinate(resolved.0, &format!("{context}.resolved.x"))?;
        validate_canvas_coordinate(resolved.1, &format!("{context}.resolved.y"))?;
    }
    Ok(())
}

fn resolve_shape_anchor(
    shape: &str,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    roundness: f64,
    t: f64,
    gap: f64,
) -> Option<(f64, f64)> {
    if !(width > 0.0 && height > 0.0) {
        return None;
    }
    let t = t.rem_euclid(1.0);
    let radians = t * std::f64::consts::TAU;
    let direction_x = zero_small(radians.sin());
    let direction_y = zero_small(-radians.cos());
    let radius_x = width / 2.0;
    let radius_y = height / 2.0;
    let (boundary_x, boundary_y) =
        shape_boundary_point(shape, width, height, roundness, (direction_x, direction_y))?;
    let local_x = boundary_x - radius_x;
    let local_y = boundary_y - radius_y;
    let rotation = rotation.to_radians();
    let (sin, cos) = rotation.sin_cos();
    let rotated_direction_x = zero_small(direction_x * cos - direction_y * sin);
    let rotated_direction_y = zero_small(direction_x * sin + direction_y * cos);
    let rotated_local_x = zero_small(local_x * cos - local_y * sin);
    let rotated_local_y = zero_small(local_x * sin + local_y * cos);
    let resolved_x = x + radius_x + rotated_local_x + rotated_direction_x * gap;
    let resolved_y = y + radius_y + rotated_local_y + rotated_direction_y * gap;
    (resolved_x.is_finite() && resolved_y.is_finite()).then_some((resolved_x, resolved_y))
}

type Point = (f64, f64);

enum BoundarySegment {
    Line {
        start: Point,
        end: Point,
    },
    Quadratic {
        start: Point,
        control: Point,
        end: Point,
    },
}

fn shape_boundary_point(
    shape: &str,
    width: f64,
    height: f64,
    roundness: f64,
    direction: Point,
) -> Option<Point> {
    let center = (width / 2.0, height / 2.0);
    if shape == "ellipse" {
        return Some((
            center.0 + direction.0 * center.0,
            center.1 + direction.1 * center.1,
        ));
    }
    let segments = boundary_segments(shape, width, height, roundness)?;
    ray_intersection_on_segments(center, direction, &segments)
}

fn boundary_segments(
    shape: &str,
    width: f64,
    height: f64,
    roundness: f64,
) -> Option<Vec<BoundarySegment>> {
    if matches!(shape, "rectangle" | "text") {
        let radius = if shape == "text" {
            0.0
        } else {
            width.min(height) * roundness.clamp(MIN_VISUAL_RECTANGLE_ROUNDNESS, 1.0) / 2.0
        };
        return Some(chain_segments(
            vec![
                Segment::Line((width - radius, 0.0)),
                Segment::Quadratic((width, 0.0), (width, radius)),
                Segment::Line((width, height - radius)),
                Segment::Quadratic((width, height), (width - radius, height)),
                Segment::Line((radius, height)),
                Segment::Quadratic((0.0, height), (0.0, height - radius)),
                Segment::Line((0.0, radius)),
                Segment::Quadratic((0.0, 0.0), (radius, 0.0)),
            ],
            (radius, 0.0),
        ));
    }
    if shape != "diamond" {
        return None;
    }
    let corner_inset = width.min(height) * DIAMOND_CORNER_INSET;
    let diagonal = width.hypot(height).max(1.0);
    let horizontal_inset = corner_inset * width / diagonal;
    let vertical_inset = corner_inset * height / diagonal;
    let center_x = width / 2.0;
    let center_y = height / 2.0;
    Some(chain_segments(
        vec![
            Segment::Quadratic(
                (center_x, 0.0),
                (center_x + horizontal_inset, vertical_inset),
            ),
            Segment::Line((width - horizontal_inset, center_y - vertical_inset)),
            Segment::Quadratic(
                (width, center_y),
                (width - horizontal_inset, center_y + vertical_inset),
            ),
            Segment::Line((center_x + horizontal_inset, height - vertical_inset)),
            Segment::Quadratic(
                (center_x, height),
                (center_x - horizontal_inset, height - vertical_inset),
            ),
            Segment::Line((horizontal_inset, center_y + vertical_inset)),
            Segment::Quadratic(
                (0.0, center_y),
                (horizontal_inset, center_y - vertical_inset),
            ),
            Segment::Line((center_x - horizontal_inset, vertical_inset)),
        ],
        (center_x - horizontal_inset, vertical_inset),
    ))
}

enum Segment {
    Line(Point),
    Quadratic(Point, Point),
}

fn chain_segments(segments: Vec<Segment>, start: Point) -> Vec<BoundarySegment> {
    let mut current = start;
    segments
        .into_iter()
        .map(|segment| match segment {
            Segment::Line(end) => {
                let segment = BoundarySegment::Line {
                    start: current,
                    end,
                };
                current = end;
                segment
            }
            Segment::Quadratic(control, end) => {
                let segment = BoundarySegment::Quadratic {
                    start: current,
                    control,
                    end,
                };
                current = end;
                segment
            }
        })
        .collect()
}

fn ray_intersection_on_segments(
    center: Point,
    direction: Point,
    segments: &[BoundarySegment],
) -> Option<Point> {
    segments
        .iter()
        .flat_map(|segment| match segment {
            BoundarySegment::Line { start, end } => {
                ray_segment_intersection(center, direction, *start, *end)
                    .into_iter()
                    .collect()
            }
            BoundarySegment::Quadratic {
                start,
                control,
                end,
            } => ray_quadratic_intersections(center, direction, *start, *control, *end),
        })
        .min_by(|first, second| {
            distance_squared(center, *first).total_cmp(&distance_squared(center, *second))
        })
}

fn ray_segment_intersection(
    origin: Point,
    direction: Point,
    start: Point,
    end: Point,
) -> Option<Point> {
    let edge = subtract(end, start);
    let denominator = cross(direction, edge);
    if denominator.abs() < RAY_INTERSECTION_TOLERANCE {
        return None;
    }
    let delta = subtract(start, origin);
    let ray = cross(delta, edge) / denominator;
    let segment = cross(delta, direction) / denominator;
    (ray >= 0.0
        && segment >= -RAY_INTERSECTION_TOLERANCE
        && segment <= 1.0 + RAY_INTERSECTION_TOLERANCE)
        .then_some((origin.0 + direction.0 * ray, origin.1 + direction.1 * ray))
}

fn ray_quadratic_intersections(
    origin: Point,
    direction: Point,
    start: Point,
    control: Point,
    end: Point,
) -> Vec<Point> {
    let a = add(subtract(start, scale(control, 2.0)), end);
    let b = scale(subtract(control, start), 2.0);
    let c = subtract(start, origin);
    quadratic_roots(
        cross(a, direction),
        cross(b, direction),
        cross(c, direction),
    )
    .into_iter()
    .filter(|ratio| {
        *ratio >= -RAY_INTERSECTION_TOLERANCE && *ratio <= 1.0 + RAY_INTERSECTION_TOLERANCE
    })
    .map(|ratio| quadratic_point(start, control, end, ratio))
    .filter(|point| dot(subtract(*point, origin), direction) >= -RAY_INTERSECTION_TOLERANCE)
    .collect()
}

fn quadratic_roots(a: f64, b: f64, c: f64) -> Vec<f64> {
    if a.abs() < RAY_INTERSECTION_TOLERANCE {
        return (b.abs() >= RAY_INTERSECTION_TOLERANCE)
            .then_some(-c / b)
            .into_iter()
            .collect();
    }
    let discriminant = b * b - 4.0 * a * c;
    if discriminant < -RAY_INTERSECTION_TOLERANCE {
        return Vec::new();
    }
    let root = discriminant.max(0.0).sqrt();
    if root == 0.0 {
        return vec![-b / (2.0 * a)];
    }
    let stable_numerator = -0.5 * (b + if b >= 0.0 { root } else { -root });
    vec![stable_numerator / a, c / stable_numerator]
}

fn quadratic_point(start: Point, control: Point, end: Point, ratio: f64) -> Point {
    let reverse = 1.0 - ratio;
    (
        reverse * reverse * start.0 + 2.0 * reverse * ratio * control.0 + ratio * ratio * end.0,
        reverse * reverse * start.1 + 2.0 * reverse * ratio * control.1 + ratio * ratio * end.1,
    )
}

fn add(first: Point, second: Point) -> Point {
    (first.0 + second.0, first.1 + second.1)
}

fn subtract(first: Point, second: Point) -> Point {
    (first.0 - second.0, first.1 - second.1)
}

fn scale(point: Point, factor: f64) -> Point {
    (point.0 * factor, point.1 * factor)
}

fn cross(first: Point, second: Point) -> f64 {
    first.0 * second.1 - first.1 * second.0
}

fn dot(first: Point, second: Point) -> f64 {
    first.0 * second.0 + first.1 * second.1
}

fn distance_squared(first: Point, second: Point) -> f64 {
    let delta = subtract(first, second);
    dot(delta, delta)
}

#[derive(Clone)]
enum ObjectBindingEndpoint {
    Free(Point),
    Element {
        target_id: String,
        gap: f64,
        legacy_t: Option<f64>,
    },
}

#[derive(Clone)]
struct ObjectBindingTarget {
    id: String,
    kind: String,
    shape: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    rotation: f64,
    roundness: f64,
    stroke_width: f64,
}

#[derive(Clone)]
struct SupportVertex {
    difference: Point,
    start: Point,
    end: Point,
}

struct ClosestSimplex {
    closest: Point,
    overlap: bool,
    simplex: Vec<SupportVertex>,
    weights: Vec<f64>,
}

enum ObjectBindingResolution {
    Separated { start: Point, end: Point },
    Overlap,
}

fn resolve_object_binding_points(
    connector_id: &str,
    connector_stroke_width: f64,
    start: &ObjectBindingEndpoint,
    end: &ObjectBindingEndpoint,
    targets: &[ObjectBindingTarget],
) -> Option<ObjectBindingResolution> {
    if let (
        ObjectBindingEndpoint::Element {
            target_id: start_id,
            legacy_t: start_t,
            gap: start_gap,
        },
        ObjectBindingEndpoint::Element {
            target_id: end_id,
            legacy_t: end_t,
            gap: end_gap,
        },
    ) = (start, end)
    {
        if start_id == end_id {
            let target = targets.iter().find(|target| target.id == *start_id)?;
            return match (start_t, end_t) {
                (Some(start_t), Some(end_t)) => Some(ObjectBindingResolution::Separated {
                    start: resolve_shape_anchor(
                        &target.shape,
                        target.x,
                        target.y,
                        target.width,
                        target.height,
                        target.rotation,
                        target.roundness,
                        *start_t,
                        *start_gap,
                    )?,
                    end: resolve_shape_anchor(
                        &target.shape,
                        target.x,
                        target.y,
                        target.width,
                        target.height,
                        target.rotation,
                        target.roundness,
                        *end_t,
                        *end_gap,
                    )?,
                }),
                _ => None,
            };
        }
    }
    let start_reference = endpoint_reference(start, targets)?;
    let end_reference = endpoint_reference(end, targets)?;
    let fallback = deterministic_direction(connector_id);
    let initial_direction = normalized_direction(start_reference, end_reference, fallback);
    let resolution = closest_object_boundary_pair(start, end, targets, initial_direction)?;
    let ObjectBindingResolution::Separated {
        start: clean_start,
        end: clean_end,
    } = resolution
    else {
        return Some(ObjectBindingResolution::Overlap);
    };
    let direction = normalized_direction(clean_start, clean_end, fallback);
    let start = apply_object_binding_clearance(
        start,
        clean_start,
        direction,
        connector_stroke_width,
        targets,
    )?;
    let end = apply_object_binding_clearance(
        end,
        clean_end,
        (-direction.0, -direction.1),
        connector_stroke_width,
        targets,
    )?;
    Some(ObjectBindingResolution::Separated { start, end })
}

fn endpoint_reference(
    endpoint: &ObjectBindingEndpoint,
    targets: &[ObjectBindingTarget],
) -> Option<Point> {
    match endpoint {
        ObjectBindingEndpoint::Free(point) => Some(*point),
        ObjectBindingEndpoint::Element { target_id, .. } => targets
            .iter()
            .find(|target| target.id == *target_id)
            .map(|target| {
                (
                    target.x + target.width / 2.0,
                    target.y + target.height / 2.0,
                )
            }),
    }
}

fn closest_object_boundary_pair(
    start: &ObjectBindingEndpoint,
    end: &ObjectBindingEndpoint,
    targets: &[ObjectBindingTarget],
    initial_direction: Point,
) -> Option<ObjectBindingResolution> {
    let support = |direction: Point| -> Option<SupportVertex> {
        let start_point = endpoint_support(start, direction, targets)?;
        let end_point = endpoint_support(end, (-direction.0, -direction.1), targets)?;
        Some(SupportVertex {
            difference: subtract(start_point, end_point),
            start: start_point,
            end: end_point,
        })
    };
    let mut state = closest_simplex_to_origin(vec![support(initial_direction)?]);
    for _ in 0..64 {
        let distance_squared = dot(state.closest, state.closest);
        if state.overlap || distance_squared <= 1e-20 {
            return Some(ObjectBindingResolution::Overlap);
        }
        let direction = (-state.closest.0, -state.closest.1);
        let next = support(direction)?;
        let improvement = distance_squared - dot(state.closest, next.difference);
        if improvement <= 1e-12 * distance_squared.max(1.0) {
            let (start, end) = simplex_witnesses(&state)?;
            return Some(ObjectBindingResolution::Separated { start, end });
        }
        if state
            .simplex
            .iter()
            .any(|vertex| distance_squared_point(vertex.difference, next.difference) <= 1e-24)
        {
            return None;
        }
        state.simplex.push(next);
        state = closest_simplex_to_origin(state.simplex);
    }
    let (start, end) = simplex_witnesses(&state)?;
    Some(ObjectBindingResolution::Separated { start, end })
}

fn endpoint_support(
    endpoint: &ObjectBindingEndpoint,
    direction: Point,
    targets: &[ObjectBindingTarget],
) -> Option<Point> {
    match endpoint {
        ObjectBindingEndpoint::Free(point) => Some(*point),
        ObjectBindingEndpoint::Element { target_id, .. } => {
            let target = targets.iter().find(|target| target.id == *target_id)?;
            let local_direction = rotate_point(direction, -target.rotation);
            let local = if target.kind == "text" {
                (
                    if local_direction.0 >= 0.0 {
                        target.width
                    } else {
                        0.0
                    },
                    if local_direction.1 >= 0.0 {
                        target.height
                    } else {
                        0.0
                    },
                )
            } else {
                shape_support_point(
                    &target.shape,
                    target.width,
                    target.height,
                    target.roundness,
                    local_direction,
                )?
            };
            let rotated = rotate_point(
                (local.0 - target.width / 2.0, local.1 - target.height / 2.0),
                target.rotation,
            );
            Some((
                target.x + target.width / 2.0 + rotated.0,
                target.y + target.height / 2.0 + rotated.1,
            ))
        }
    }
}

fn shape_support_point(
    shape: &str,
    width: f64,
    height: f64,
    roundness: f64,
    direction: Point,
) -> Option<Point> {
    let center = (width / 2.0, height / 2.0);
    if shape == "ellipse" {
        let denominator = (center.0 * direction.0).hypot(center.1 * direction.1);
        return (denominator > 1e-12)
            .then_some((
                center.0 + center.0 * center.0 * direction.0 / denominator,
                center.1 + center.1 * center.1 * direction.1 / denominator,
            ))
            .or(Some(center));
    }
    let mut best = None;
    let mut best_projection = f64::NEG_INFINITY;
    let mut consider = |point: Point| {
        let projection = dot(point, direction);
        if projection > best_projection + 1e-12 {
            best = Some(point);
            best_projection = projection;
        }
    };
    for segment in boundary_segments(shape, width, height, roundness)? {
        match segment {
            BoundarySegment::Line { start, end } => {
                consider(start);
                consider(end);
            }
            BoundarySegment::Quadratic {
                start,
                control,
                end,
            } => {
                consider(start);
                consider(end);
                let coefficient_a = dot(add(subtract(start, scale(control, 2.0)), end), direction);
                let coefficient_b = 2.0 * dot(subtract(control, start), direction);
                if coefficient_a < -1e-12 {
                    let ratio = -coefficient_b / (2.0 * coefficient_a);
                    if ratio > 0.0 && ratio < 1.0 {
                        consider(quadratic_point(start, control, end, ratio));
                    }
                }
            }
        }
    }
    best
}

fn closest_simplex_to_origin(simplex: Vec<SupportVertex>) -> ClosestSimplex {
    if simplex.len() == 1 {
        return ClosestSimplex {
            closest: simplex[0].difference,
            overlap: false,
            simplex,
            weights: vec![1.0],
        };
    }
    if simplex.len() == 2 {
        return closest_segment_simplex(simplex[0].clone(), simplex[1].clone());
    }
    let triangle = simplex[simplex.len() - 3..].to_vec();
    if origin_inside_triangle(
        triangle[0].difference,
        triangle[1].difference,
        triangle[2].difference,
    ) {
        return ClosestSimplex {
            closest: (0.0, 0.0),
            overlap: true,
            simplex: triangle,
            weights: vec![0.0; 3],
        };
    }
    let edges = [
        closest_segment_simplex(triangle[0].clone(), triangle[1].clone()),
        closest_segment_simplex(triangle[1].clone(), triangle[2].clone()),
        closest_segment_simplex(triangle[2].clone(), triangle[0].clone()),
    ];
    edges
        .into_iter()
        .reduce(|best, candidate| {
            if dot(candidate.closest, candidate.closest) < dot(best.closest, best.closest) - 1e-16 {
                candidate
            } else {
                best
            }
        })
        .unwrap()
}

fn closest_segment_simplex(first: SupportVertex, second: SupportVertex) -> ClosestSimplex {
    let edge = subtract(second.difference, first.difference);
    let size = dot(edge, edge);
    let ratio = if size <= 1e-24 {
        0.0
    } else {
        (-dot(first.difference, edge) / size).clamp(0.0, 1.0)
    };
    if ratio <= 1e-14 {
        return ClosestSimplex {
            closest: first.difference,
            overlap: false,
            simplex: vec![first],
            weights: vec![1.0],
        };
    }
    if ratio >= 1.0 - 1e-14 {
        return ClosestSimplex {
            closest: second.difference,
            overlap: false,
            simplex: vec![second],
            weights: vec![1.0],
        };
    }
    ClosestSimplex {
        closest: add(first.difference, scale(edge, ratio)),
        overlap: false,
        simplex: vec![first, second],
        weights: vec![1.0 - ratio, ratio],
    }
}

fn origin_inside_triangle(first: Point, second: Point, third: Point) -> bool {
    let first_cross = cross(subtract(second, first), (-first.0, -first.1));
    let second_cross = cross(subtract(third, second), (-second.0, -second.1));
    let third_cross = cross(subtract(first, third), (-third.0, -third.1));
    (first_cross >= -1e-12 && second_cross >= -1e-12 && third_cross >= -1e-12)
        || (first_cross <= 1e-12 && second_cross <= 1e-12 && third_cross <= 1e-12)
}

fn simplex_witnesses(state: &ClosestSimplex) -> Option<(Point, Point)> {
    if state.overlap || state.simplex.len() != state.weights.len() {
        return None;
    }
    Some(state.simplex.iter().zip(&state.weights).fold(
        ((0.0, 0.0), (0.0, 0.0)),
        |points, (vertex, weight)| {
            (
                add(points.0, scale(vertex.start, *weight)),
                add(points.1, scale(vertex.end, *weight)),
            )
        },
    ))
}

fn apply_object_binding_clearance(
    endpoint: &ObjectBindingEndpoint,
    point: Point,
    direction: Point,
    connector_stroke_width: f64,
    targets: &[ObjectBindingTarget],
) -> Option<Point> {
    match endpoint {
        ObjectBindingEndpoint::Free(_) => Some(point),
        ObjectBindingEndpoint::Element { target_id, gap, .. } => {
            let target = targets.iter().find(|target| target.id == *target_id)?;
            let target_stroke = if target.kind == "shape" {
                target.stroke_width
            } else {
                0.0
            };
            let clearance = gap + target_stroke / 2.0 + connector_stroke_width.max(0.0) / 2.0;
            Some(add(point, scale(direction, clearance)))
        }
    }
}

fn normalized_direction(from: Point, to: Point, fallback: Point) -> Point {
    let delta = subtract(to, from);
    let length = delta.0.hypot(delta.1);
    if length > 1e-12 && length.is_finite() {
        scale(delta, 1.0 / length)
    } else {
        fallback
    }
}

fn rotate_point(point: Point, degrees: f64) -> Point {
    let radians = degrees.to_radians();
    let (sin, cos) = radians.sin_cos();
    (
        zero_small(point.0 * cos - point.1 * sin),
        zero_small(point.0 * sin + point.1 * cos),
    )
}

fn deterministic_direction(value: &str) -> Point {
    let mut hash: u32 = 2_166_136_261;
    for code_unit in value.encode_utf16() {
        hash ^= u32::from(code_unit);
        hash = hash.wrapping_mul(16_777_619);
    }
    let angle = f64::from(hash) / 4_294_967_296.0 * std::f64::consts::TAU;
    (angle.cos(), angle.sin())
}

fn distance_squared_point(first: Point, second: Point) -> f64 {
    distance_squared(first, second)
}

fn zero_small(value: f64) -> f64 {
    if value.abs() < 1e-12 {
        0.0
    } else {
        value
    }
}
fn number_i64(v: &Value, key: &str) -> i64 {
    v.get(key)
        .and_then(Value::as_i64)
        .or_else(|| v.get(key).and_then(Value::as_u64).map(|n| n as i64))
        .unwrap()
}

pub fn initialize_storage_at(root: &Path) -> Result<StorageDiagnostics, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let db = root.join("note.db");
    let mut c = database::open(&db)?;
    let version = database::migrate(&mut c)?;
    let import = legacy_import::import_if_needed(
        &mut c,
        &root.join("note-data.json"),
        &root.join("backups"),
        &root.join("assets"),
    )?;
    Ok(StorageDiagnostics {
        database_path: db.to_string_lossy().into_owned(),
        schema_version: version,
        imported_legacy_data: import.imported,
        backup_path: import.backup_path.map(|p| p.to_string_lossy().into_owned()),
        warnings: import.warnings,
    })
}
pub fn load_workspace_data_at(root: &Path) -> Result<WorkspaceData, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    let folders = {
        let mut s = c
            .prepare("SELECT id,name FROM folders WHERE id NOT IN (?,?) ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map(params![ROOT_FOLDER_ID, TEMPLATE_FOLDER_ID], |r| {
                Ok(FolderDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let pages = {
        let mut s = c
            .prepare("SELECT id,folder_id,title,is_bookmarked,revision FROM pages ORDER BY rowid")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| {
                Ok(PageDto {
                    id: r.get(0)?,
                    folder_id: r.get(1)?,
                    title: r.get(2)?,
                    is_bookmarked: r.get::<_, i64>(3)? != 0,
                    revision: r.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let elements = {
        let mut s = c
            .prepare("SELECT payload_json FROM elements ORDER BY page_id,z_index,id")
            .map_err(|e| e.to_string())?;
        let rows = s
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .map(|v| {
                serde_json::from_str(&v.map_err(|e| e.to_string())?)
                    .map_err(|e| format!("corrupt element payload: {e}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let theme: Option<String> = c
        .query_row("SELECT theme FROM app_settings WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    let session: Option<String> = c
        .query_row("SELECT state_json FROM session_state WHERE id=1", [], |r| {
            r.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(WorkspaceData {
        folders,
        pages,
        elements,
        is_dark_mode: theme.map(|v| v == "dark"),
        session_state: session
            .map(|v| serde_json::from_str(&v).map_err(|e| format!("corrupt session state: {e}")))
            .transpose()?,
        warnings: Vec::new(),
    })
}

fn validate_workspace_structure(structure: &WorkspaceStructure) -> Result<(), String> {
    let mut folder_ids = std::collections::HashSet::new();
    for folder in &structure.folders {
        if folder.id.trim().is_empty() {
            return Err("folder.id must be a non-empty string".into());
        }
        if matches!(folder.id.as_str(), ROOT_FOLDER_ID | TEMPLATE_FOLDER_ID) {
            return Err(format!("folder.id {} is reserved", folder.id));
        }
        if folder.name.trim().is_empty() {
            return Err("folder.name must be a non-empty string".into());
        }
        if !folder_ids.insert(folder.id.as_str()) {
            return Err(format!("duplicate folder id: {}", folder.id));
        }
    }

    let mut page_ids = std::collections::HashSet::new();
    for page in &structure.pages {
        if page.id.trim().is_empty() {
            return Err("page.id must be a non-empty string".into());
        }
        if page.title.trim().is_empty() {
            return Err("page.title must be a non-empty string".into());
        }
        if !page_ids.insert(page.id.as_str()) {
            return Err(format!("duplicate page id: {}", page.id));
        }
        if !matches!(page.folder_id.as_str(), ROOT_FOLDER_ID | TEMPLATE_FOLDER_ID)
            && !folder_ids.contains(page.folder_id.as_str())
        {
            return Err(format!(
                "page {} references missing folder {}",
                page.id, page.folder_id
            ));
        }
    }
    Ok(())
}

/// Reconciles user-visible folders and pages in a single transaction. Scene
/// rows are intentionally not accepted here: callers flush the corresponding
/// page queues before issuing a potentially destructive structure update.
pub fn reconcile_workspace_structure_at(
    root: &Path,
    structure: WorkspaceStructure,
) -> Result<WorkspaceStructureResult, String> {
    validate_workspace_structure(&structure)?;
    let mut connection = database::open(&root.join("note.db"))?;
    database::migrate(&mut connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;

    transaction
        .execute(
            "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            params![ROOT_FOLDER_ID, "Root"],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
            params![TEMPLATE_FOLDER_ID, "Templates"],
        )
        .map_err(|error| error.to_string())?;
    for folder in &structure.folders {
        transaction
            .execute(
                "INSERT INTO folders(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",
                params![folder.id, folder.name.trim()],
            )
            .map_err(|error| format!("save folder {}: {error}", folder.id))?;
    }

    let desired_page_ids: std::collections::HashSet<&str> = structure
        .pages
        .iter()
        .map(|page| page.id.as_str())
        .collect();
    let existing_page_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM pages")
            .map_err(|error| error.to_string())?;
        let page_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        page_ids
    };
    for page_id in existing_page_ids {
        if !desired_page_ids.contains(page_id.as_str()) {
            transaction
                .execute("DELETE FROM pages WHERE id=?", [page_id])
                .map_err(|error| error.to_string())?;
        }
    }
    for page in &structure.pages {
        transaction
            .execute(
                "INSERT INTO pages(id,folder_id,title,is_bookmarked) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET folder_id=excluded.folder_id,title=excluded.title,is_bookmarked=excluded.is_bookmarked",
                params![page.id, page.folder_id, page.title.trim(), page.is_bookmarked as i64],
            )
            .map_err(|error| format!("save page {}: {error}", page.id))?;
    }

    let desired_folder_ids: std::collections::HashSet<&str> = structure
        .folders
        .iter()
        .map(|folder| folder.id.as_str())
        .chain([ROOT_FOLDER_ID, TEMPLATE_FOLDER_ID])
        .collect();
    let existing_folder_ids = {
        let mut statement = transaction
            .prepare("SELECT id FROM folders")
            .map_err(|error| error.to_string())?;
        let folder_ids = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        folder_ids
    };
    for folder_id in existing_folder_ids {
        if !desired_folder_ids.contains(folder_id.as_str()) {
            transaction
                .execute("DELETE FROM folders WHERE id=?", [folder_id])
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(is_dark_mode) = structure.is_dark_mode {
        transaction
            .execute(
                "INSERT INTO app_settings(id,theme) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme",
                [if is_dark_mode { "dark" } else { "light" }],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;

    let pages = load_workspace_data_at(root)?.pages;
    Ok(WorkspaceStructureResult { pages })
}
pub fn apply_scene_changes_at(
    root: &Path,
    batch: SceneChangeBatch,
) -> Result<SceneChangeResult, String> {
    if batch.page_id.is_empty() || batch.base_revision < 0 {
        return Err("invalid pageId or baseRevision".into());
    }
    validate_scene_batch(&batch)?;
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    let tx = c
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let revision: Option<i64> = tx
        .query_row(
            "SELECT revision FROM pages WHERE id=?",
            [&batch.page_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let revision = revision.ok_or_else(|| format!("page not found: {}", batch.page_id))?;
    if revision != batch.base_revision {
        return Err(format!(
            "revision conflict: expected {revision}, received {}",
            batch.base_revision
        ));
    }
    for id in &batch.deleted_element_ids {
        tx.execute(
            "DELETE FROM elements WHERE id=? AND page_id=?",
            params![id, batch.page_id],
        )
        .map_err(|e| e.to_string())?;
    }
    for e in &batch.upserts {
        let json = serde_json::to_string(e).map_err(|e| e.to_string())?;
        let kind = required_string(e, "type")?;
        if kind == "image" {
            assets::validate_reference(&tx, &root.join("assets"), required_string(e, "assetId")?)?;
        }
        let locked = e["locked"].as_bool().unwrap() as i64;
        let existing_page: Option<String> = tx
            .query_row(
                "SELECT page_id FROM elements WHERE id=?",
                [required_string(e, "id")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing_page
            .as_deref()
            .is_some_and(|id| id != batch.page_id)
        {
            return Err(format!(
                "element {} already belongs to another page",
                required_string(e, "id")?
            ));
        }
        tx.execute("INSERT INTO elements(id,page_id,element_type,x,y,width,height,rotation,z_index,opacity,locked,group_id,created_at,updated_at,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET page_id=excluded.page_id,element_type=excluded.element_type,x=excluded.x,y=excluded.y,width=excluded.width,height=excluded.height,rotation=excluded.rotation,z_index=excluded.z_index,opacity=excluded.opacity,locked=excluded.locked,group_id=excluded.group_id,updated_at=excluded.updated_at,payload_json=excluded.payload_json",params![required_string(e,"id")?,batch.page_id,kind,finite(e,"x")?,finite(e,"y")?,finite(e,"width")?,finite(e,"height")?,finite(e,"rotation")?,number_i64(e,"zIndex"),e["opacity"].as_f64(),locked,e.get("groupId").and_then(Value::as_str),number_i64(e,"createdAt"),number_i64(e,"updatedAt"),json]).map_err(|er|format!("upsert element: {er}"))?;
    }
    validate_final_connector_bindings(&tx, &batch.page_id)?;
    let next = revision + 1;
    tx.execute(
        "UPDATE pages SET revision=? WHERE id=?",
        params![next, batch.page_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SceneChangeResult {
        page_id: batch.page_id,
        new_revision: next,
    })
}
fn validate_session_state(state: &Value) -> Result<(), String> {
    let session = state.as_object().ok_or("session state must be an object")?;
    if let Some(locked) = session.get("isDrawingToolLocked") {
        if !locked.is_boolean() {
            return Err("session state.isDrawingToolLocked must be boolean".into());
        }
    }
    if let Some(text_preferences) = session.get("textPreferences") {
        let text_preferences = text_preferences
            .as_object()
            .ok_or("session state.textPreferences must be an object")?;
        if !matches!(
            text_preferences
                .get("backgroundMode")
                .and_then(Value::as_str),
            Some("surface" | "transparent")
        ) {
            return Err("session state.textPreferences.backgroundMode is invalid".into());
        }
    }
    if let Some(preferences) = session.get("drawingPreferences") {
        let preferences = preferences
            .as_object()
            .ok_or("session state.drawingPreferences must be an object")?;
        for tool in [
            "pen",
            "highlighter",
            "rectangle",
            "ellipse",
            "diamond",
            "line",
            "arrow",
        ] {
            let context = format!("session state.drawingPreferences.{tool}");
            let preference = preferences
                .get(tool)
                .and_then(Value::as_object)
                .ok_or_else(|| format!("{context} must be an object"))?;
            validate_ink_color(
                preference
                    .get("strokeColor")
                    .ok_or_else(|| format!("{context}.strokeColor is required"))?,
            )?;
            if let Some(background) = preference.get("backgroundColor") {
                if !background.is_null() {
                    validate_ink_color(background)?;
                }
            } else {
                return Err(format!("{context}.backgroundColor is required"));
            }
            for (key, minimum, maximum, allow_zero) in [
                ("opacity", 0.0, 1.0, true),
                ("roughness", 0.0, 10.0, true),
                ("roundness", 0.0, 1.0, true),
                ("strokeWidth", 0.0, 512.0, false),
            ] {
                let number = preference
                    .get(key)
                    .and_then(Value::as_f64)
                    .filter(|number| number.is_finite())
                    .ok_or_else(|| format!("{context}.{key} must be finite"))?;
                if !(minimum..=maximum).contains(&number) || (!allow_zero && number == 0.0) {
                    return Err(format!("{context}.{key} is out of range"));
                }
            }
            if !matches!(
                preference.get("strokeStyle").and_then(Value::as_str),
                Some("solid" | "dashed" | "dotted")
            ) {
                return Err(format!("{context}.strokeStyle is invalid"));
            }
        }
    }
    Ok(())
}

pub fn save_session_state_at(root: &Path, state: Value) -> Result<(), String> {
    validate_session_state(&state)?;
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    c.execute("INSERT INTO session_state(id,state_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json",[serde_json::to_string(&state).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn save_asset_at(root: &Path, request: SaveAssetRequest) -> Result<AssetDto, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    assets::save(&c, &root.join("assets"), request)
}
pub fn load_asset_at(root: &Path, id: &str) -> Result<AssetDto, String> {
    let mut c = database::open(&root.join("note.db"))?;
    database::migrate(&mut c)?;
    assets::load(&c, &root.join("assets"), id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use serde_json::json;
    use std::fs;

    fn fixture_endpoint(value: &Value) -> ObjectBindingEndpoint {
        match value.get("kind").and_then(Value::as_str).unwrap() {
            "free" => ObjectBindingEndpoint::Free((
                value["x"].as_f64().unwrap(),
                value["y"].as_f64().unwrap(),
            )),
            "element" => ObjectBindingEndpoint::Element {
                target_id: value["targetElementId"].as_str().unwrap().to_owned(),
                gap: value["gap"].as_f64().unwrap(),
                legacy_t: value
                    .get("anchor")
                    .and_then(|anchor| anchor.get("t"))
                    .and_then(Value::as_f64),
            },
            kind => panic!("unexpected fixture endpoint kind: {kind}"),
        }
    }

    #[test]
    fn object_binding_resolver_matches_shared_golden_vectors() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/connector-object-binding-golden-vectors.json"
        ))
        .unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            let targets = vector["targets"]
                .as_array()
                .unwrap()
                .iter()
                .map(|target| ObjectBindingTarget {
                    id: target["id"].as_str().unwrap().to_owned(),
                    kind: target["kind"].as_str().unwrap().to_owned(),
                    shape: target["shape"].as_str().unwrap().to_owned(),
                    x: target["x"].as_f64().unwrap(),
                    y: target["y"].as_f64().unwrap(),
                    width: target["width"].as_f64().unwrap(),
                    height: target["height"].as_f64().unwrap(),
                    rotation: target["rotation"].as_f64().unwrap(),
                    roundness: target["roundness"].as_f64().unwrap(),
                    stroke_width: target["strokeWidth"].as_f64().unwrap(),
                })
                .collect::<Vec<_>>();
            let name = vector["name"].as_str().unwrap();
            let resolution = resolve_object_binding_points(
                name,
                vector["connectorStrokeWidth"].as_f64().unwrap(),
                &fixture_endpoint(&vector["start"]),
                &fixture_endpoint(&vector["end"]),
                &targets,
            );
            let Some(expected) = vector
                .get("expected")
                .filter(|expected| !expected.is_null())
            else {
                assert!(
                    resolution.is_none()
                        || matches!(resolution, Some(ObjectBindingResolution::Overlap)),
                    "{name}"
                );
                continue;
            };
            let Some(ObjectBindingResolution::Separated { start, end }) = resolution else {
                panic!("{name} did not resolve");
            };
            for (actual, expected, coordinate) in [
                (start.0, expected["start"]["x"].as_f64().unwrap(), "start.x"),
                (start.1, expected["start"]["y"].as_f64().unwrap(), "start.y"),
                (end.0, expected["end"]["x"].as_f64().unwrap(), "end.x"),
                (end.1, expected["end"]["y"].as_f64().unwrap(), "end.y"),
            ] {
                assert!(
                    (actual - expected).abs() <= 1e-8,
                    "{name} {coordinate}: {actual} != {expected}"
                );
            }
        }
    }
    use tempfile::TempDir;

    fn root() -> TempDir {
        tempfile::tempdir().unwrap()
    }
    fn seed_page(root: &Path) {
        initialize_storage_at(root).unwrap();
        let connection = database::open(&root.join("note.db")).unwrap();
        connection
            .execute("INSERT INTO folders(id,name) VALUES('f','Folder')", [])
            .unwrap();
        connection
            .execute(
                "INSERT INTO pages(id,folder_id,title) VALUES('p','f','Page')",
                [],
            )
            .unwrap();
    }
    fn seed_additional_page(root: &Path, page_id: &str) {
        let connection = database::open(&root.join("note.db")).unwrap();
        connection
            .execute(
                "INSERT INTO pages(id,folder_id,title) VALUES(?,'f','Page')",
                [page_id],
            )
            .unwrap();
    }
    fn element(id: &str, updated_at: i64) -> Value {
        json!({"id":id,"pageId":"p","type":"text","x":1.0,"y":2.0,"width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":updated_at,"content":"hello"})
    }
    fn image_element(id: &str, asset_id: &str) -> Value {
        json!({"id":id,"pageId":"p","type":"image","x":1.0,"y":2.0,"width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"assetId":asset_id,"naturalWidth":100,"naturalHeight":40,"fit":"contain"})
    }
    fn connector_element(start: Value, end: Value) -> Value {
        connector_element_on_page("connector-1", "p", start, end, true)
    }
    fn connector_element_on_page(
        id: &str,
        page_id: &str,
        start: Value,
        end: Value,
        is_arrow: bool,
    ) -> Value {
        json!({
            "id":id,"pageId":page_id,"type":"connector","zIndex":0,
            "opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,
            "routing":"straight","start":start,"end":end,
            "style":{
                "fillColor":null,"roughness":1.0,"roundness":0.0,"seed":1,
                "strokeColor":{"kind":"theme","token":"foreground"},"strokeStyle":"solid",
                "strokeWidth":2.0,"startArrowhead":"none","endArrowhead":if is_arrow { "arrow" } else { "none" }
            }
        })
    }
    fn shape_element(id: &str, page_id: &str) -> Value {
        json!({
            "id":id,"pageId":page_id,"type":"shape","x":10.0,"y":20.0,
            "width":100.0,"height":60.0,"rotation":0.0,"zIndex":0,
            "opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,
            "shape":"rectangle"
        })
    }
    fn ink_element() -> Value {
        json!({
            "id":"ink-1","pageId":"p","type":"ink","x":1.0,"y":2.0,
            "width":100.0,"height":40.0,"rotation":0.0,"zIndex":0,
            "opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,
            "points":[[2.0,3.0,0.5],[98.0,38.0,1.0]],
            "brush":{
                "kind":"pen","color":{"kind":"theme","token":"foreground"},
                "size":4.0,"opacity":1.0,"thinning":0.45,"smoothing":0.5,
                "streamline":0.45,"simulatePressure":true
            }
        })
    }
    fn assert_ink_rejected_without_revision_change(root: &Path, ink: Value, message: &str) {
        let error = apply_scene_changes_at(
            root,
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![ink],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(
            error.contains(message),
            "unexpected validation error: {error}"
        );
        assert_eq!(load_workspace_data_at(root).unwrap().pages[0].revision, 0);
    }

    fn drawing_preferences() -> Value {
        let preference = json!({
            "backgroundColor":null,
            "opacity":1.0,
            "roughness":1.2,
            "roundness":0.0,
            "strokeColor":{"kind":"theme","token":"foreground"},
            "strokeStyle":"solid",
            "strokeWidth":2.0
        });
        json!({
            "pen":preference.clone(),
            "highlighter":preference.clone(),
            "rectangle":preference.clone(),
            "ellipse":preference.clone(),
            "diamond":preference.clone(),
            "line":preference.clone(),
            "arrow":preference
        })
    }

    #[test]
    fn session_drawing_preferences_require_valid_typed_values() {
        assert!(validate_session_state(&json!({
            "isDrawingToolLocked":true,
            "drawingPreferences":drawing_preferences()
        }))
        .is_ok());

        let mut invalid = drawing_preferences();
        invalid["pen"]["strokeWidth"] = json!(0);
        let error = validate_session_state(&json!({"drawingPreferences":invalid})).unwrap_err();
        assert!(error.contains("pen.strokeWidth"));
        assert!(
            validate_session_state(&json!({"isDrawingToolLocked":"yes"}))
                .unwrap_err()
                .contains("must be boolean")
        );
    }

    #[test]
    fn text_background_modes_accept_legacy_omission_and_reject_invalid_values() {
        let legacy_text = element("legacy-text", 1);
        assert!(validate_element(&legacy_text, "p").is_ok());

        let mut transparent_text = element("transparent-text", 1);
        transparent_text["backgroundMode"] = json!("transparent");
        assert!(validate_element(&transparent_text, "p").is_ok());

        let mut invalid_text = element("invalid-text", 1);
        invalid_text["backgroundMode"] = json!("gradient");
        assert!(validate_element(&invalid_text, "p")
            .unwrap_err()
            .contains("backgroundMode"));

        assert!(validate_session_state(&json!({})).is_ok());
        assert!(validate_session_state(&json!({
            "textPreferences":{"backgroundMode":"surface"}
        }))
        .is_ok());
        assert!(validate_session_state(&json!({
            "textPreferences":{"backgroundMode":"transparent"}
        }))
        .is_ok());
        assert!(validate_session_state(&json!({"textPreferences":null}))
            .unwrap_err()
            .contains("textPreferences"));
        assert!(validate_session_state(&json!({
            "textPreferences":{"backgroundMode":"gradient"}
        }))
        .unwrap_err()
        .contains("backgroundMode"));
        assert!(validate_session_state(&json!({"textPreferences":{}}))
            .unwrap_err()
            .contains("backgroundMode"));
    }

    #[test]
    fn primitive_payloads_validate_new_fields_and_preserve_legacy_payloads() {
        let directory = root();
        seed_page(directory.path());
        let legacy_shape = json!({"id":"shape","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle"});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![legacy_shape],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let invalid = json!({"id":"bad","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":1,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"strokeStyle":"zigzag","seed":-1,"roughness":-1,"roundness":2,"strokeWidth":0}});
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![invalid],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("roughness"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            1
        );
    }

    #[test]
    fn shape_owned_rich_text_round_trips_without_changing_legacy_omission() {
        let directory = root();
        seed_page(directory.path());
        let legacy_shape = shape_element("legacy-shape", "p");
        let mut labeled_shape = shape_element("labeled-shape", "p");
        labeled_shape["x"] = json!(40.0);
        labeled_shape["text"] = json!({
            "content":"Heading\nImportant",
            "richContent":{
                "type":"doc",
                "content":[
                    {"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Heading"}]},
                    {"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Important","marks":[{"type":"bold"},{"type":"textStyle","attrs":{"fontFamily":"Inter","fontSize":"18px"}}]}]}]}]},
                    {"type":"image","attrs":{"src":"data:image/png;base64,AA==","alt":"Diagram","width":24,"height":12}}
                ]
            }
        });

        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![legacy_shape.clone(), labeled_shape.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let loaded = load_workspace_data_at(directory.path()).unwrap();
        let legacy = loaded
            .elements
            .iter()
            .find(|element| element["id"] == "legacy-shape")
            .unwrap();
        let labeled = loaded
            .elements
            .iter()
            .find(|element| element["id"] == "labeled-shape")
            .unwrap();
        assert!(legacy.get("text").is_none());
        assert_eq!(labeled["text"], labeled_shape["text"]);
    }

    #[test]
    fn malformed_or_excessive_shape_rich_text_is_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let baseline = shape_element("baseline", "p");
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![baseline],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let before = load_workspace_data_at(directory.path()).unwrap();

        for invalid_text in [
            json!("label"),
            json!({"content":1}),
            json!({"content":"label","richContent":{"type":"paragraph"}}),
            json!({"content":"label","richContent":{"type":"doc","content":[{"type":"script","text":"bad"}]}}),
            json!({"content":"label","richContent":{"type":"doc","content":[{"type":"heading","attrs":{"level":9}}]}}),
            json!({"content":"label","richContent":{"type":"doc","content":[{"type":"paragraph"}]},"legacy":true}),
        ] {
            let mut invalid = shape_element("invalid", "p");
            invalid["text"] = invalid_text;
            let error = apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 1,
                    upserts: vec![invalid],
                    deleted_element_ids: vec!["baseline".into()],
                },
            )
            .unwrap_err();
            assert!(
                error.contains("shape element.text"),
                "unexpected validation error: {error}"
            );
            let after = load_workspace_data_at(directory.path()).unwrap();
            assert_eq!(after.pages[0].revision, 1);
            assert_eq!(after.elements, before.elements);
        }

        let mut nested = json!({"type":"paragraph"});
        for _ in 0..=MAX_RICH_TEXT_DEPTH {
            nested = json!({"type":"blockquote","content":[nested]});
        }
        let mut invalid_depth = shape_element("deep", "p");
        invalid_depth["text"] =
            json!({"content":"deep","richContent":{"type":"doc","content":[nested]}});
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![invalid_depth],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("depth limit"));
        let after = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(after.pages[0].revision, 1);
        assert_eq!(after.elements, before.elements);
    }

    #[test]
    fn legacy_standalone_rich_text_remains_permissive_and_byte_equivalent() {
        let directory = root();
        seed_page(directory.path());
        let legacy_rich = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":"legacy","marks":[
                {"type":"link","attrs":{"href":"custom:destination","title":null}},
                {"type":"textStyle","attrs":{"fontFamily":"arbitrary-family","fontSize":"144px","legacy":true}}
            ]}]},
            {"type":"image","attrs":{"src":"data:image/svg+xml;base64,PHN2Zz4=","alt":null}}
        ]});
        let mut standalone = element("legacy-rich-text", 1);
        standalone["richContent"] = legacy_rich.clone();
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![standalone],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(loaded.elements[0]["richContent"], legacy_rich);

        let mut shape = shape_element("strict-shape", "p");
        shape["text"] = json!({"content":"legacy","richContent":legacy_rich});
        assert!(validate_element(&shape, "p").is_err());
    }

    #[test]
    fn rich_text_security_vectors_match_frontend_policy() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/rich-text-security-vectors.json"
        ))
        .unwrap();
        for vector in vectors["valid"].as_array().unwrap() {
            let mut shape = shape_element("valid-vector", "p");
            shape["text"] = json!({
                "content":"vector",
                "richContent":vector["doc"].clone()
            });
            assert!(
                validate_element(&shape, "p").is_ok(),
                "valid vector failed: {}",
                vector["name"]
            );
        }
        for vector in vectors["invalid"].as_array().unwrap() {
            let mut shape = shape_element("invalid-vector", "p");
            shape["text"] = json!({
                "content":"vector",
                "richContent":vector["doc"].clone()
            });
            assert!(
                validate_element(&shape, "p").is_err(),
                "invalid vector passed: {}",
                vector["name"]
            );
        }
    }

    #[test]
    fn rich_text_aggregate_text_and_attribute_limits_are_enforced() {
        let text = "x".repeat(3 * 1024 * 1024);
        let text_document = json!({"type":"doc","content":[
            {"type":"paragraph","content":[{"type":"text","text":text}]},
            {"type":"paragraph","content":[{"type":"text","text":text}]}
        ]});
        assert!(validate_rich_text_document(&text_document, "aggregate")
            .unwrap_err()
            .contains("aggregate text"));

        let image_source = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(vec![0; 5 * 1024 * 1024])
        );
        let attribute_document = json!({"type":"doc","content":[
            {"type":"image","attrs":{"src":image_source}},
            {"type":"image","attrs":{"src":image_source}}
        ]});
        assert!(
            validate_rich_text_document(&attribute_document, "aggregate")
                .unwrap_err()
                .contains("aggregate attribute")
        );
    }

    #[test]
    fn embedded_rich_image_decoded_limit_is_exact_and_atomic() {
        let directory = root();
        seed_page(directory.path());
        let mut at_limit = shape_element("at-limit", "p");
        at_limit["text"] = json!({
            "content":"image",
            "richContent":{"type":"doc","content":[{"type":"image","attrs":{
                "src":format!("data:image/png;base64,{}", STANDARD.encode(vec![0; MAX_EMBEDDED_RICH_IMAGE_BYTES]))
            }}]}
        });
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![at_limit],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let before = load_workspace_data_at(directory.path()).unwrap();

        let mut over_limit = shape_element("over-limit", "p");
        over_limit["text"] = json!({
            "content":"image",
            "richContent":{"type":"doc","content":[{"type":"image","attrs":{
                "src":format!("data:image/png;base64,{}", STANDARD.encode(vec![0; MAX_EMBEDDED_RICH_IMAGE_BYTES + 1]))
            }}]}
        });
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![over_limit],
                deleted_element_ids: vec!["at-limit".into()],
            },
        )
        .unwrap_err();
        assert!(error.contains("decoded byte limit"));
        let after = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(after.pages[0].revision, 1);
        assert_eq!(after.elements, before.elements);
    }

    #[test]
    fn connector_element_endpoints_preserve_valid_bindings_and_reject_malformed_values() {
        let directory = root();
        seed_page(directory.path());
        let bound = connector_element(
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":4.0}),
            json!({"kind":"free","x":160.0,"y":60.0}),
        );
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![shape_element("shape-1", "p"), bound.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .into_iter()
                .find(|element| element["id"] == "connector-1")
                .unwrap()["start"],
            bound["start"]
        );

        for (start, message) in [
            (
                json!({"kind":"element","targetElementId":"","anchor":{"t":0.25},"gap":0.0}),
                "targetElementId must be a non-empty string",
            ),
            (
                json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":1.1},"gap":0.0}),
                "anchor must be within 0 and 1",
            ),
            (
                json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":-1.0}),
                "gap must be between",
            ),
            (
                json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25,"side":"right"},"gap":0.0}),
                "anchor.side is not supported",
            ),
        ] {
            let error = apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 1,
                    upserts: vec![connector_element(
                        start,
                        json!({"kind":"free","x":1.0,"y":1.0}),
                    )],
                    deleted_element_ids: vec![],
                },
            )
            .unwrap_err();
            assert!(
                error.contains(message),
                "unexpected validation error: {error}"
            );
            assert_eq!(
                load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
                1
            );
        }
    }

    #[test]
    fn canonical_object_bindings_persist_reject_same_target_and_allow_overlap() {
        let directory = root();
        seed_page(directory.path());
        let canonical = connector_element(
            json!({"kind":"element","targetElementId":"shape-1","gap":4.0}),
            json!({"kind":"free","x":160.0,"y":60.0}),
        );
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![shape_element("shape-1", "p"), canonical.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .into_iter()
                .find(|element| element["id"] == "connector-1")
                .unwrap()["start"],
            canonical["start"]
        );

        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![connector_element(
                    json!({"kind":"element","targetElementId":"shape-1","gap":0.0}),
                    json!({"kind":"element","targetElementId":"shape-1","gap":0.0}),
                )],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("same-target canonical binding"));

        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![
                    shape_element("shape-2", "p"),
                    connector_element(
                        json!({"kind":"element","targetElementId":"shape-1","gap":0.0}),
                        json!({"kind":"element","targetElementId":"shape-2","gap":0.0}),
                    ),
                ],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            2
        );
    }

    #[test]
    fn connector_element_endpoints_preserve_arbitrary_and_legacy_seam_anchors() {
        let directory = root();
        seed_page(directory.path());
        let arbitrary = connector_element(
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.1736111111111111},"gap":0.0}),
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":1.0},"gap":0.0}),
        );
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![shape_element("shape-1", "p"), arbitrary.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let persisted = load_workspace_data_at(directory.path())
            .unwrap()
            .elements
            .into_iter()
            .find(|element| element["id"] == "connector-1")
            .unwrap();
        assert_eq!(persisted["start"], arbitrary["start"]);
        assert_eq!(persisted["end"], arbitrary["end"]);
    }

    #[test]
    fn boundary_resolver_matches_shared_golden_vectors() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/fixtures/connector-boundary-golden-vectors.json"
        ))
        .unwrap();
        for vector in fixture["vectors"].as_array().unwrap() {
            let number = |key: &str| vector[key].as_f64().unwrap();
            let shape = if vector["kind"].as_str() == Some("text") {
                "text"
            } else {
                vector["shape"].as_str().unwrap()
            };
            let resolved = resolve_shape_anchor(
                shape,
                number("x"),
                number("y"),
                number("width"),
                number("height"),
                number("rotation"),
                number("roundness"),
                number("t"),
                number("gap"),
            )
            .unwrap();
            let expected = vector["expected"].as_object().unwrap();
            let expected_x = expected["x"].as_f64().unwrap();
            let expected_y = expected["y"].as_f64().unwrap();
            assert!(
                (resolved.0 - expected_x).abs() < 1e-8,
                "{} resolved x={} instead of {}",
                vector["name"],
                resolved.0,
                expected_x
            );
            assert!(
                (resolved.1 - expected_y).abs() < 1e-8,
                "{} resolved y={} instead of {}",
                vector["name"],
                resolved.1,
                expected_y
            );
            assert_eq!(
                resolved.0.abs() <= MAX_CANVAS_VALUE && resolved.1.abs() <= MAX_CANVAS_VALUE,
                vector["accepted"].as_bool().unwrap(),
                "{} acceptance diverged from the persisted canvas boundary",
                vector["name"]
            );
        }
    }

    #[test]
    fn bound_connector_endpoints_require_final_same_page_arrow_targets() {
        let directory = root();
        seed_page(directory.path());
        let target = shape_element("shape-1", "p");
        let bound_start =
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":4.0});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![
                    target.clone(),
                    connector_element(
                        bound_start.clone(),
                        json!({"kind":"free","x":160.0,"y":60.0}),
                    ),
                ],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let text_bound = connector_element_on_page(
            "text-connector",
            "p",
            json!({"kind":"element","targetElementId":"text-1","anchor":{"t":0.0},"gap":4.0}),
            json!({"kind":"free","x":160.0,"y":60.0}),
            true,
        );
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![element("text-1", 1), text_bound],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        seed_additional_page(directory.path(), "other-page");
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "other-page".into(),
                base_revision: 0,
                upserts: vec![shape_element("other-shape", "other-page")],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let invalid_cases = [
            (
                "missing",
                connector_element_on_page(
                    "missing-connector",
                    "p",
                    json!({"kind":"element","targetElementId":"missing","anchor":{"t":0.25},"gap":4.0}),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    true,
                ),
                vec![],
                "existing compatible element",
            ),
            (
                "incompatible-image",
                connector_element_on_page(
                    "incompatible-connector",
                    "p",
                    json!({"kind":"element","targetElementId":"ink-1","anchor":{"t":0.25},"gap":4.0}),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    true,
                ),
                vec![ink_element()],
                "rectangle, ellipse, diamond, or text block",
            ),
            (
                "cross-page",
                connector_element_on_page(
                    "cross-page-connector",
                    "p",
                    json!({"kind":"element","targetElementId":"other-shape","anchor":{"t":0.25},"gap":4.0}),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    true,
                ),
                vec![],
                "same page",
            ),
            (
                "line",
                connector_element_on_page(
                    "line-connector",
                    "p",
                    bound_start.clone(),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    false,
                ),
                vec![],
                "only supported for arrow connectors",
            ),
            (
                "group",
                connector_element_on_page(
                    "group-connector",
                    "p",
                    json!({"kind":"group","targetGroupId":"group-1","anchor":{"t":0.25},"gap":4.0}),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    true,
                ),
                vec![],
                "kind is invalid",
            ),
            (
                "connector",
                connector_element_on_page(
                    "connector-target-connector",
                    "p",
                    json!({"kind":"connector","targetConnectorId":"connector-1","pathT":0.25,"gap":4.0}),
                    json!({"kind":"free","x":160.0,"y":60.0}),
                    true,
                ),
                vec![],
                "kind is invalid",
            ),
        ];

        for (name, connector, mut upserts, expected_error) in invalid_cases {
            upserts.push(connector);
            let error = apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 2,
                    upserts,
                    deleted_element_ids: vec![],
                },
            )
            .unwrap_err();
            assert!(
                error.contains(expected_error),
                "{name} produced unexpected validation error: {error}"
            );
            assert_eq!(
                load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
                2
            );
        }
    }

    #[test]
    fn deleting_bound_shape_requires_same_batch_connector_detachment() {
        let directory = root();
        seed_page(directory.path());
        let bound_start =
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":4.0});
        let bound = connector_element(bound_start, json!({"kind":"free","x":160.0,"y":60.0}));
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![shape_element("shape-1", "p"), bound.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![],
                deleted_element_ids: vec!["shape-1".into()],
            },
        )
        .unwrap_err();
        assert!(error.contains("existing compatible element"));
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .len(),
            2
        );
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            1
        );

        let mut detached = bound;
        detached["start"] = json!({"kind":"free","x":14.0,"y":24.0});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![detached],
                deleted_element_ids: vec!["shape-1".into()],
            },
        )
        .unwrap();
        let workspace = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(workspace.elements.len(), 1);
        assert_eq!(workspace.elements[0]["start"]["kind"], "free");
        assert_eq!(workspace.pages[0].revision, 2);
    }

    #[test]
    fn boundary_free_endpoint_persists_while_deleting_bound_target() {
        let directory = root();
        seed_page(directory.path());
        let bound = connector_element(
            json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":4.0}),
            json!({"kind":"free","x":160.0,"y":60.0}),
        );
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![shape_element("shape-1", "p"), bound.clone()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let mut detached = bound;
        detached["start"] = json!({"kind":"free","x":MAX_CANVAS_VALUE,"y":0.0});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![detached],
                deleted_element_ids: vec!["shape-1".into()],
            },
        )
        .unwrap();

        let workspace = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(workspace.elements.len(), 1);
        assert_eq!(workspace.elements[0]["start"]["kind"], "free");
        assert_eq!(workspace.elements[0]["start"]["x"], MAX_CANVAS_VALUE);
        assert_eq!(workspace.pages[0].revision, 2);
    }

    #[test]
    fn canvas_geometry_and_connector_endpoints_have_safe_magnitude_limits() {
        for (mut element, key, expected_error) in [
            (element("too-far", 1), "x", "element.x"),
            (shape_element("too-wide", "p"), "width", "element.width"),
            (element("too-rotated", 1), "rotation", "element.rotation"),
        ] {
            element[key] = json!(MAX_CANVAS_VALUE + 1.0);
            let directory = root();
            seed_page(directory.path());
            let error = apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 0,
                    upserts: vec![element],
                    deleted_element_ids: vec![],
                },
            )
            .unwrap_err();
            assert!(
                error.contains(expected_error),
                "unexpected validation error: {error}"
            );
            assert_eq!(
                load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
                0
            );
        }

        for (endpoint, expected_error) in [
            (
                json!({"kind":"free","x":MAX_CANVAS_VALUE + 1.0,"y":1.0}),
                "connector.start.x",
            ),
            (
                json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":MAX_CANVAS_VALUE + 1.0}),
                "connector.start.gap",
            ),
        ] {
            let directory = root();
            seed_page(directory.path());
            let error = apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 0,
                    upserts: vec![
                        shape_element("shape-1", "p"),
                        connector_element(endpoint, json!({"kind":"free","x":1.0,"y":1.0})),
                    ],
                    deleted_element_ids: vec![],
                },
            )
            .unwrap_err();
            assert!(
                error.contains(expected_error),
                "unexpected validation error: {error}"
            );
            assert_eq!(
                load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
                0
            );
        }
    }

    #[test]
    fn bound_endpoint_resolution_must_fit_the_free_coordinate_limit() {
        let directory = root();
        seed_page(directory.path());
        let mut edge_shape = shape_element("shape-1", "p");
        edge_shape["x"] = json!(MAX_CANVAS_VALUE - 1.0);
        edge_shape["width"] = json!(1.0);
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![
                    edge_shape,
                    connector_element(
                        json!({"kind":"element","targetElementId":"shape-1","anchor":{"t":0.25},"gap":MAX_CANVAS_VALUE}),
                        json!({"kind":"free","x":1.0,"y":1.0}),
                    ),
                ],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("connector connector-1.start.resolved.x"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn rounded_boundary_acceptance_and_unsafe_resolution_are_atomic() {
        let directory = root();
        seed_page(directory.path());
        let mut rounded_shape = shape_element("rounded-shape", "p");
        rounded_shape["x"] = json!(999_900.25);
        rounded_shape["y"] = json!(20.0);
        rounded_shape["width"] = json!(100.0);
        rounded_shape["height"] = json!(60.0);
        rounded_shape["style"] = json!({"roundness":0.6});
        let rounded_connector = connector_element_on_page(
            "rounded-connector",
            "p",
            json!({"kind":"element","targetElementId":"rounded-shape","anchor":{"t":0.2},"gap":0.0}),
            json!({"kind":"free","x":1.0,"y":1.0}),
            true,
        );
        assert_eq!(
            apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 0,
                    upserts: vec![rounded_shape, rounded_connector],
                    deleted_element_ids: vec![],
                },
            )
            .unwrap()
            .new_revision,
            1
        );
        let before = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(before.elements.len(), 2);

        let mut unsafe_shape = shape_element("unsafe-shape", "p");
        unsafe_shape["x"] = json!(MAX_CANVAS_VALUE - 1.0);
        unsafe_shape["y"] = json!(20.0);
        unsafe_shape["width"] = json!(1.0);
        unsafe_shape["height"] = json!(1.0);
        let unsafe_connector = connector_element_on_page(
            "unsafe-connector",
            "p",
            json!({"kind":"element","targetElementId":"unsafe-shape","anchor":{"t":0.25},"gap":1.0}),
            json!({"kind":"free","x":1.0,"y":1.0}),
            true,
        );
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![unsafe_shape, unsafe_connector],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("connector unsafe-connector.start.resolved.x"));

        let after = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(after.pages[0].revision, 1);
        assert_eq!(after.elements, before.elements);
    }

    #[test]
    fn primitive_colors_allow_legacy_omission_and_nullable_fill_but_reject_null_stroke() {
        let directory = root();
        seed_page(directory.path());
        let legacy_shape = json!({"id":"legacy","pageId":"p","type":"shape","x":0.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":0,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle"});
        let transparent_shape = json!({"id":"transparent","pageId":"p","type":"shape","x":20.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":1,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"fillColor":null,"strokeColor":{"kind":"theme","token":"foreground"}}});
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![legacy_shape, transparent_shape],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();

        let null_stroke = json!({"id":"null-stroke","pageId":"p","type":"shape","x":40.0,"y":0.0,"width":10.0,"height":10.0,"rotation":0.0,"zIndex":2,"opacity":1.0,"locked":false,"createdAt":1,"updatedAt":1,"shape":"rectangle","style":{"strokeColor":null}});
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![null_stroke],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("ink brush.color must be an object"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            1
        );
    }

    #[test]
    fn empty_initialization_and_migration_are_idempotent() {
        let directory = root();
        let first = initialize_storage_at(directory.path()).unwrap();
        let second = initialize_storage_at(directory.path()).unwrap();
        assert_eq!(first.schema_version, database::SCHEMA_VERSION);
        assert!(!first.imported_legacy_data);
        assert_eq!(first.schema_version, second.schema_version);
        assert!(directory.path().join("note.db").exists());
    }

    #[test]
    fn scene_batch_insert_update_delete_and_revision_conflict() {
        let directory = root();
        seed_page(directory.path());
        assert_eq!(
            apply_scene_changes_at(
                directory.path(),
                SceneChangeBatch {
                    page_id: "p".into(),
                    base_revision: 0,
                    upserts: vec![element("e", 1)],
                    deleted_element_ids: vec![]
                }
            )
            .unwrap()
            .new_revision,
            1
        );
        let conflict = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(conflict.contains("revision conflict"));
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 1,
                upserts: vec![element("e", 2)],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 2,
                upserts: vec![],
                deleted_element_ids: vec!["e".into()],
            },
        )
        .unwrap();
        assert!(load_workspace_data_at(directory.path())
            .unwrap()
            .elements
            .is_empty());
    }

    #[test]
    fn corrupt_batch_is_rejected_before_revision_changes() {
        let directory = root();
        seed_page(directory.path());
        let mut bad = element("e", 1);
        bad["opacity"] = json!(2.0);
        assert!(apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![bad],
                deleted_element_ids: vec![]
            }
        )
        .is_err());
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn valid_phase_four_ink_is_persisted() {
        let directory = root();
        seed_page(directory.path());
        let result = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![ink_element()],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        assert_eq!(result.new_revision, 1);
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .len(),
            1
        );
    }

    #[test]
    fn ink_without_brush_is_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut ink = ink_element();
        ink.as_object_mut().unwrap().remove("brush");
        assert_ink_rejected_without_revision_change(
            directory.path(),
            ink,
            "brush must be an object",
        );
    }

    #[test]
    fn malformed_ink_tuple_and_pressure_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut malformed = ink_element();
        malformed["points"] = json!([[1.0, 2.0]]);
        assert_ink_rejected_without_revision_change(
            directory.path(),
            malformed,
            "exactly [x, y, pressure]",
        );

        let mut bad_pressure = ink_element();
        bad_pressure["points"] = json!([[1.0, 2.0, 1.1]]);
        assert_ink_rejected_without_revision_change(
            directory.path(),
            bad_pressure,
            "pressure must be between 0 and 1",
        );
    }

    #[test]
    fn excessive_ink_points_and_payload_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut too_many = ink_element();
        too_many["points"] = Value::Array(
            (0..=MAX_INK_POINTS)
                .map(|_| json!([1.0, 1.0, 0.5]))
                .collect(),
        );
        assert_ink_rejected_without_revision_change(directory.path(), too_many, "point limit");

        let mut oversized = ink_element();
        oversized["padding"] = Value::String("x".repeat(MAX_INK_PAYLOAD_BYTES));
        assert_ink_rejected_without_revision_change(directory.path(), oversized, "payload exceeds");
    }

    #[test]
    fn excessive_scene_batch_count_and_bytes_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let too_many = vec![element("duplicate-is-not-reached", 1); MAX_SCENE_BATCH_UPSERTS + 1];
        let count_error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: too_many,
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(count_error.contains("upsert limit"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );

        let mut first = element("large-1", 1);
        first["content"] = Value::String("x".repeat(17 * 1024 * 1024));
        let mut second = element("large-2", 1);
        second["content"] = Value::String("x".repeat(17 * 1024 * 1024));
        let byte_error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![first, second],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(byte_error.contains("batch payload exceeds"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn invalid_ink_color_and_brush_ranges_are_rejected_atomically() {
        let directory = root();
        seed_page(directory.path());
        let mut bad_color = ink_element();
        bad_color["brush"]["color"] = json!({"kind":"fixed","value":"red"});
        assert_ink_rejected_without_revision_change(directory.path(), bad_color, "#RRGGBB");

        for (key, value, message) in [
            ("size", json!(513.0), "size must be"),
            ("opacity", json!(-0.1), "opacity must be between"),
            ("thinning", json!(1.1), "thinning must be between"),
            ("smoothing", json!(1.1), "smoothing must be between"),
            ("streamline", json!(1.1), "streamline must be between"),
            (
                "simulatePressure",
                json!("yes"),
                "simulatePressure must be boolean",
            ),
        ] {
            let mut invalid = ink_element();
            invalid["brush"][key] = value;
            assert_ink_rejected_without_revision_change(directory.path(), invalid, message);
        }
    }

    #[test]
    fn deleting_page_cascades_elements() {
        let directory = root();
        seed_page(directory.path());
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![element("e", 1)],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        connection
            .execute("DELETE FROM pages WHERE id='p'", [])
            .unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM elements", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn asset_write_and_read_round_trip() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let bytes = b"png bytes";
        let saved = save_asset_at(
            directory.path(),
            SaveAssetRequest {
                data_base64: STANDARD.encode(bytes),
                media_type: "image/png".into(),
                file_name: Some("../../unsafe.png".into()),
                natural_width: Some(2),
                natural_height: Some(3),
            },
        )
        .unwrap();
        let loaded = load_asset_at(directory.path(), &saved.id).unwrap();
        assert_eq!(STANDARD.decode(loaded.data_base64.unwrap()).unwrap(), bytes);
        assert!(!directory.path().join("unsafe.png").exists());
    }

    #[test]
    fn asset_decode_enforces_encoded_and_decoded_boundaries() {
        let at_limit = vec![7_u8; assets::MAX_ASSET_BYTES];
        assert_eq!(
            assets::decode_base64_limited(&STANDARD.encode(&at_limit))
                .unwrap()
                .len(),
            assets::MAX_ASSET_BYTES
        );

        let encoded_limit = assets::MAX_ASSET_BYTES.div_ceil(3) * 4;
        let encoded_too_large = "A".repeat(encoded_limit + 1);
        assert!(assets::decode_base64_limited(&encoded_too_large)
            .unwrap_err()
            .contains("maximum encoded size"));

        let decoded_too_large = vec![7_u8; assets::MAX_ASSET_BYTES + 1];
        assert!(
            assets::decode_base64_limited(&STANDARD.encode(decoded_too_large))
                .unwrap_err()
                .contains("maximum decoded size")
        );
    }

    #[test]
    fn image_batch_rejects_missing_asset_without_revision_advance() {
        let directory = root();
        seed_page(directory.path());
        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![image_element("image", "missing")],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("image asset not found"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn image_batch_rejects_asset_row_without_managed_file() {
        let directory = root();
        seed_page(directory.path());
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        connection.execute("INSERT INTO assets(id,relative_path,file_name,media_type,byte_size,created_at) VALUES('missing-file','missing.png','missing.png','image/png',1,1)", []).unwrap();
        drop(connection);

        let error = apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "p".into(),
                base_revision: 0,
                upserts: vec![image_element("image", "missing-file")],
                deleted_element_ids: vec![],
            },
        )
        .unwrap_err();
        assert!(error.contains("file is unavailable"));
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().pages[0].revision,
            0
        );
    }

    #[test]
    fn legacy_import_creates_backup_preserves_mixed_content_and_is_idempotent() {
        let directory = root();
        let legacy = json!({"folders":[{"id":"f","name":"F"}],"pages":[{"id":"p","folderId":"f","title":"P"}],"blocks":[{"id":"b","pageId":"p","x":1,"y":2,"width":3,"height":4,"content":"text","backgroundMode":"transparent","richContent":{"type":"doc","content":[{"type":"paragraph"}]},"imageData":format!("data:image/png;base64,{}",STANDARD.encode(b"image")),"imageName":"x.png"}],"isDarkMode":true,"sessionState":{"selectedPageId":"p","textPreferences":{"backgroundMode":"transparent"},"pageViewports":{"p":{"panOffset":{"x":1,"y":2},"zoomLevel":1.5}}}});
        let path = directory.path().join("note-data.json");
        fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        let original = fs::read(&path).unwrap();
        let first = initialize_storage_at(directory.path()).unwrap();
        assert!(first.imported_legacy_data);
        assert_eq!(first.warnings.len(), 1);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert!(std::path::Path::new(&first.backup_path.unwrap()).exists());
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(loaded.elements.len(), 2);
        assert_eq!(
            loaded.elements[0]["richContent"],
            legacy["blocks"][0]["richContent"]
        );
        assert_eq!(loaded.elements[0]["backgroundMode"], "transparent");
        assert_eq!(
            loaded.session_state.unwrap()["textPreferences"]["backgroundMode"],
            "transparent"
        );
        let second = initialize_storage_at(directory.path()).unwrap();
        assert!(!second.imported_legacy_data);
        assert_eq!(
            load_workspace_data_at(directory.path())
                .unwrap()
                .elements
                .len(),
            2
        );
    }

    #[test]
    fn malformed_legacy_rolls_back_and_preserves_original() {
        let directory = root();
        let raw=br#"{"folders":[{"id":"f","name":"F"}],"pages":[{"id":"p","folderId":"missing","title":"P"}],"blocks":[]}"#;
        let path = directory.path().join("note-data.json");
        fs::write(&path, raw).unwrap();
        assert!(initialize_storage_at(directory.path()).is_err());
        assert_eq!(fs::read(path).unwrap(), raw);
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        let count: i64 = connection
            .query_row("SELECT count(*) FROM folders", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn mixed_legacy_image_id_avoids_later_original_block_id() {
        let directory = root();
        let legacy = json!({
            "folders":[{"id":"f","name":"F"}],
            "pages":[{"id":"p","folderId":"f","title":"P"}],
            "blocks":[
                {"id":"b","pageId":"p","x":0,"y":0,"width":10,"height":10,"content":"text","imageData":format!("data:image/png;base64,{}",STANDARD.encode(b"image"))},
                {"id":"b-image","pageId":"p","x":20,"y":20,"width":10,"height":10,"content":"later block"}
            ]
        });
        fs::write(
            directory.path().join("note-data.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();

        initialize_storage_at(directory.path()).unwrap();
        let ids = load_workspace_data_at(directory.path())
            .unwrap()
            .elements
            .into_iter()
            .map(|element| element["id"].as_str().unwrap().to_owned())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(ids.len(), 3);
        assert!(ids.contains("b"));
        assert!(ids.contains("b-image"));
        assert!(ids.contains("b-image-2"));
    }

    #[test]
    fn workspace_structure_keeps_hidden_root_and_template_folders() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let result = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "projects".into(),
                    name: "Projects".into(),
                }],
                pages: vec![
                    WorkspacePageDto {
                        id: "root-page".into(),
                        folder_id: ROOT_FOLDER_ID.into(),
                        title: "Root".into(),
                        is_bookmarked: false,
                    },
                    WorkspacePageDto {
                        id: "template-page".into(),
                        folder_id: TEMPLATE_FOLDER_ID.into(),
                        title: "Template".into(),
                        is_bookmarked: true,
                    },
                    WorkspacePageDto {
                        id: "project-page".into(),
                        folder_id: "projects".into(),
                        title: "Project".into(),
                        is_bookmarked: false,
                    },
                ],
                is_dark_mode: Some(true),
            },
        )
        .unwrap();

        assert_eq!(result.pages.len(), 3);
        assert_eq!(
            load_workspace_data_at(directory.path()).unwrap().folders,
            vec![FolderDto {
                id: "projects".into(),
                name: "Projects".into()
            }]
        );
        let connection = database::open(&directory.path().join("note.db")).unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM folders", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            3
        );
    }

    #[test]
    fn workspace_structure_rejects_bad_foreign_keys_and_preserves_revisions() {
        let directory = root();
        initialize_storage_at(directory.path()).unwrap();
        let saved = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "folder".into(),
                    name: "Folder".into(),
                }],
                pages: vec![WorkspacePageDto {
                    id: "page".into(),
                    folder_id: "folder".into(),
                    title: "Original".into(),
                    is_bookmarked: false,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap();
        assert_eq!(saved.pages[0].revision, 0);
        let mut page_element = element("element", 1);
        page_element["pageId"] = json!("page");
        apply_scene_changes_at(
            directory.path(),
            SceneChangeBatch {
                page_id: "page".into(),
                base_revision: 0,
                upserts: vec![page_element],
                deleted_element_ids: vec![],
            },
        )
        .unwrap();
        let updated = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![FolderDto {
                    id: "folder".into(),
                    name: "Folder renamed".into(),
                }],
                pages: vec![WorkspacePageDto {
                    id: "page".into(),
                    folder_id: "folder".into(),
                    title: "Renamed".into(),
                    is_bookmarked: true,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap();
        assert_eq!(updated.pages[0].revision, 1);
        let rejected = reconcile_workspace_structure_at(
            directory.path(),
            WorkspaceStructure {
                folders: vec![],
                pages: vec![WorkspacePageDto {
                    id: "bad".into(),
                    folder_id: "missing".into(),
                    title: "Bad".into(),
                    is_bookmarked: false,
                }],
                is_dark_mode: None,
            },
        )
        .unwrap_err();
        assert!(rejected.contains("missing folder"));
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert_eq!(loaded.pages.len(), 1);
        assert_eq!(loaded.pages[0].title, "Renamed");
        assert_eq!(loaded.pages[0].revision, 1);
    }

    #[test]
    fn legacy_root_page_migrates_with_hidden_folder() {
        let directory = root();
        let legacy = json!({
            "folders": [],
            "pages": [{"id":"root-page","folderId":"","title":"Root"}],
            "blocks": []
        });
        fs::write(
            directory.path().join("note-data.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        initialize_storage_at(directory.path()).unwrap();
        let loaded = load_workspace_data_at(directory.path()).unwrap();
        assert!(loaded.folders.is_empty());
        assert_eq!(loaded.pages[0].folder_id, ROOT_FOLDER_ID);
    }
}
