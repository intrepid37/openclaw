import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import {
  readAvatarGatewayContext,
  setAvatarGatewayOrigin,
} from "../lib/identity-avatar-context.ts";
import { cleanupSolid, mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { PluginThemeArtwork } from "./plugin-theme-artwork.tsx";

afterEach(cleanupSolid);

it("shows the fallback while replacing artwork with a different URL", async () => {
  const gateway = readAvatarGatewayContext();
  const firstUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/first";
  const nextUrl = "/__openclaw__/plugin-theme-art/synthetic/reload/icons/next";
  const next = Promise.withResolvers<Response>();
  const artwork = () =>
    new Response(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#4169e1"/></svg>',
      { headers: { "Content-Type": "image/svg+xml" } },
    );
  const fetch = globalThis.fetch;
  const artworkFetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      input === firstUrl
        ? Promise.resolve(artwork())
        : input === nextUrl
          ? next.promise
          : fetch(input, init),
    );
  const [url, setUrl] = createSignal(firstUrl);
  try {
    setAvatarGatewayOrigin(location.origin);
    const view = mountSolid(() => (
      <PluginThemeArtwork url={url()} class="synthetic-hat" fallback="Loading artwork" />
    ));
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLImageElement>("img")?.naturalWidth).toBe(256),
    );
    const firstSource = view.container.querySelector("img")!.src;
    setUrl(nextUrl);
    await waitForSolid(() =>
      expect(artworkFetch.mock.calls.some(([input]) => input === nextUrl)).toBe(true),
    );
    await waitForSolid(() => {
      expect(view.container.textContent).toBe("Loading artwork");
      expect(view.container.querySelector("img")).toBeNull();
    });
    next.resolve(artwork());
    await waitForSolid(() => {
      const image = view.container.querySelector<HTMLImageElement>("img");
      expect(image?.naturalWidth).toBe(256);
      expect(image?.src).not.toBe(firstSource);
      expect(view.container.textContent).toBe("");
    });
  } finally {
    next.resolve(artwork());
    artworkFetch.mockRestore();
    setAvatarGatewayOrigin(gateway.origin, gateway.authTokens, gateway.resourceBasePath);
  }
});
