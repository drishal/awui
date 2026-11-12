import { describe, expect, it } from "vitest";
import { orderedTourFiles, patchFiles, safeTourPath } from "../../src/server/pr-tour.js";
import type { TourFile } from "../../src/shared/protocol.js";

const bins = { source: "source", tests: "tests", generated: "generated" } as const;
const file = (path: string): TourFile => ({ path, bucket: path.includes("test") ? bins.tests : path.startsWith("dist") ? bins.generated : bins.source, diff: null });

describe("PR review tour diff parsing and reading order", () => {
  it("reads source before tests and generated content, with mechanical changes last", () => {
    expect(orderedTourFiles(["dist/bundle.js", "src/main.ts", "test/check.js", "package-lock.json", "tsconfig.json"].map(file)).map((f) => f.path))
      .toEqual(["src/main.ts", "test/check.js", "dist/bundle.js", "package-lock.json", "tsconfig.json"]);
  });

  it("keeps pathological paths outside the tour-path contract", () => {
    for (const path of ["../outside/main.js", "/main.js", "src/../../evil.ts", "", "src/\0evil.ts"]) expect(safeTourPath(path)).toBeNull();
    expect(safeTourPath("src/path/to.js")).toBe("src/path/to.js");
  });

  it("recognizes true headers, clips binary data, and bounds the guide", () => {
    expect(patchFiles("diff --git a/README.md b/README.md\n+hi\ndiff --git a/src/main.js b/src/main.js\n+return answer;\n").files.map((f) => f.path)).toEqual(["README.md", "src/main.js"]);
    expect(patchFiles("remote message\ndiff --git a/src/main.js b/src/main.js\n+authentication;\n").files[0]?.path).toBe("src/main.js");
    expect(patchFiles("diff --git a/image.png b/image.png\nBinary files a/image.png and b/image.png differ\n").files[0]).toMatchObject({ path: "image.png", bucket: "source", note: "Binary diff omitted; inspect it on GitHub" });
    const removed = patchFiles("diff --git a/src/legacy.ts b/src/legacy.ts\ndeleted file mode 100644\n--- a/src/legacy.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed;\n").files;
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ path: "src/legacy.ts", diff: { removed: 1 } });
    expect(patchFiles(Array.from({ length: 81 }, (_, i) => `diff --git a/src/${i}.js b/src/${i}.js\n+line;`).join("\n")).truncated).toBe(true);
  });
});
