// A theme in miniature: a sidebar, two lines of text, a row of status chips,
// and a composer, drawn from the same tokens the page uses. A scheme sets its
// own contrast-checked variables on the swatch (through the CSSOM, as React's
// style prop does), so what is shown is what choosing it gives; the built-in
// Light and Dark take their tokens from tokens.css by `data-swatch`, and
// System shows both halves. Decorative: the choice beside it carries the name.
import type { CSSProperties } from "react";
import type { ThemeOption } from "../themes.js";

function Face({ option, mode }: { option: ThemeOption; mode?: "light" | "dark" }) {
  const scheme = option.entry;
  const builtin = mode ?? (option.theme === "light" ? "light" : option.theme === "dark" ? "dark" : undefined);
  return (
    <span className="theme-swatch-face" {...(scheme ? { style: scheme.vars as CSSProperties } : { "data-swatch": builtin ?? "light" })}>
      <span className="sw-side">
        <i />
        <i className="sw-on" />
        <i />
      </span>
      <span className="sw-main">
        <i className="sw-line" />
        <i className="sw-line sw-short" />
        <span className="sw-chips">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <i className="sw-input">
          <b />
        </i>
      </span>
    </span>
  );
}

export function ThemeSwatch({ option, size = "md" }: { option: ThemeOption; size?: "sm" | "md" }) {
  const split = option.key === "system";
  return (
    <span className={`theme-swatch is-${size}${split ? " is-split" : ""}`} aria-hidden="true">
      {split ? (
        <>
          <Face option={option} mode="light" />
          <Face option={option} mode="dark" />
        </>
      ) : (
        <Face option={option} />
      )}
    </span>
  );
}
