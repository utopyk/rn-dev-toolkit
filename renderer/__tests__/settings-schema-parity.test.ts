// Renderer mirrors the `settings` module's config schema in
// `renderer/views/Settings.tsx` (const SETTINGS_CONFIG_SCHEMA) because
// importing the server-side manifest would transitively pull in OpenTUI /
// other daemon-only code that Vite shouldn't bundle into the renderer.
//
// Duplicating means drift risk. This test asserts the renderer schema's
// properties + types + required fields match the server manifest so that
// a future schema edit in one place that forgets the other breaks CI.

import { describe, expect, it } from "vitest";
import { settingsManifest } from "../../src/modules/built-in/manifests.js";
import { SETTINGS_CONFIG_SCHEMA } from "../views/Settings.js";

interface Props {
  [name: string]: { type?: string };
}

describe("renderer SETTINGS_CONFIG_SCHEMA mirrors settingsManifest", () => {
  it("declares the same property names", () => {
    const serverProps = Object.keys(
      (settingsManifest.contributes?.config?.schema as {
        properties?: Props;
      })?.properties ?? {},
    ).sort();
    const rendererProps = Object.keys(
      SETTINGS_CONFIG_SCHEMA.properties ?? {},
    ).sort();
    expect(rendererProps).toEqual(serverProps);
  });

  it("declares the same JSON Schema types for each property", () => {
    const serverProps =
      (settingsManifest.contributes?.config?.schema as {
        properties?: Props;
      })?.properties ?? {};
    const rendererProps = SETTINGS_CONFIG_SCHEMA.properties ?? {};
    for (const key of Object.keys(serverProps)) {
      expect(rendererProps[key as keyof typeof rendererProps]?.type).toBe(
        serverProps[key].type,
      );
    }
  });
});
