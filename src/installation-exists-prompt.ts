import { ConfigurationBuilder } from "ogi-addon";

/**
 * Buttons for the "Installation Exists" prompt, shown when `INSTALL HERE`
 * already has files. Every option needs a display name: ogi-addon's schema
 * rejects an empty one when the prompt is built.
 */
export function installationExistsPrompt(): ConfigurationBuilder {
  return new ConfigurationBuilder()
    .addActionOption((option) =>
      option
        .setDisplayName("Retry")
        .setButtonText("Retry")
        .setName("retry")
        .setDescription("Do you want to retry the download?"),
    )
    .addActionOption((option) =>
      option
        .setDisplayName("Continue")
        .setButtonText("Continue")
        .setName("continue")
        .setDescription("Do you want to continue with the existing files?"),
    );
}
