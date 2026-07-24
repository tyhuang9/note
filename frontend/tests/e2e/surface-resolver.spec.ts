import { expect, test } from "@playwright/test";
import { resolveSurface } from "../../src/surfaces/resolveSurface";

test("native main label wins over a development URL override", async () => {
  const surface = await resolveSurface({
    getNativeWindowLabel: async () => "main",
    getSearch: () => "?surface=widget",
    isDevelopment: true,
    isNative: () => true,
  });

  expect(surface).toEqual({ kind: "main" });
});

test("unknown mocked native label fails closed", async () => {
  const surface = await resolveSurface({
    getNativeWindowLabel: async () => "unexpected-native-label",
    getSearch: () => "?surface=main",
    isDevelopment: true,
    isNative: () => true,
  });

  expect(surface).toEqual({
    kind: "unsupported",
    label: "unexpected-native-label",
  });
});

test("production browser ignores surface query overrides", async () => {
  const surface = await resolveSurface({
    getNativeWindowLabel: async () => "widget",
    getSearch: () => "?surface=widget",
    isDevelopment: false,
    isNative: () => false,
  });

  expect(surface).toEqual({ kind: "main" });
});
