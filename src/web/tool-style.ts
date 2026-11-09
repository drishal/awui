// How a turn's work is drawn: the card that groups a run's calls as one tile (the
// default), or the flat line list older versions drew, where the header names what
// the run ran ("Worked for 11s · 4 commands") and each call is a plain line. The
// choice is config.yml's `tool_style`, shared by every device (Settings → Tool
// calls); the folds, the collapse after a turn, and the motion are the same either
// way, so this only tells the drawing which skin to use.
import { createContext, useContext } from "react";
import type { ToolStyle } from "../shared/protocol.js";

export const ToolStyleContext = createContext<ToolStyle>("cards");

export function useToolStyle(): ToolStyle {
  return useContext(ToolStyleContext);
}
