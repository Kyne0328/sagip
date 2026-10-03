/**
 * Source/test builds keep this empty and read responder assets from the filesystem.
 * The Neon packaging build replaces this module with a generated route-to-base64 map
 * so production serving does not depend on the serverless runtime exposing bundle files.
 */
export const BUNDLED_RESPONDER_ASSETS: Readonly<Record<string, string>> = {};
