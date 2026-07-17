import { useEffect, useState } from "react";

export interface WorkbenchViewportState {
  readonly isCompactWorkbench: boolean;
  readonly isNarrowWorkbench: boolean;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatch = () => setMatches(mediaQuery.matches);

    updateMatch();
    mediaQuery.addEventListener("change", updateMatch);

    return () => mediaQuery.removeEventListener("change", updateMatch);
  }, [query]);

  return matches;
}

export function useWorkbenchViewport(): WorkbenchViewportState {
  return {
    isCompactWorkbench: useMediaQuery("(max-width: 1279px)"),
    isNarrowWorkbench: useMediaQuery("(max-width: 899px)"),
  };
}
