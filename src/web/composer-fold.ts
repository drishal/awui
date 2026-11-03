// When the phone's composer folds to one pill row (Claude's app): a + to the
// left, the box's placeholder, the context chip and Send/Stop to the right.
// It stays open while you are writing in it or touching it, and while anything
// in it would be hidden by folding (a draft, images, a long paste, the command
// menu, a drop). Pure: Composer decides with it, and it is tested alone.
export interface FoldState {
  /** A phone-width screen: a wide screen keeps its row of pickers in view. */
  phone: boolean;
  /** The start screen's big composer, which is the page's point and never folds. */
  hero: boolean;
  closed: boolean;
  /** The box has focus, or focus is still on something inside the card. */
  writing: boolean;
  text: string;
  images: number;
  pastes: number;
  menuOpen: boolean;
  dragging: boolean;
}

export function composerFolded(s: FoldState): boolean {
  return s.phone && !s.hero && !s.closed && !s.writing && s.text.length === 0 && s.images === 0 && s.pastes === 0 && !s.menuOpen && !s.dragging;
}
