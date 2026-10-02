import { describe, expect, it } from "bun:test";
import { installationExistsPrompt } from "./installation-exists-prompt";

describe("installationExistsPrompt", () => {
  it("passes ogi-addon's own validation (build(false) rejects empty display names)", () => {
    expect(() => installationExistsPrompt().build(false)).not.toThrow();
  });

  it("offers retry and continue buttons with display names", () => {
    const config = installationExistsPrompt().build(false);
    expect(Object.keys(config)).toEqual(["retry", "continue"]);
    expect(config.retry.displayName).toBe("Retry");
    expect(config.continue.displayName).toBe("Continue");
  });

  it("describes continue as continuing with the existing files", () => {
    const config = installationExistsPrompt().build(false);
    expect(config.continue.description).toBe(
      "Do you want to continue with the existing files?",
    );
  });
});
