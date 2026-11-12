// The REAL @netlify/blobs client (as installed in node_modules), connected to a FakeBlobs server over its
// HTTP adapter. Used to prove that the FakeStore model behaves like the real client (fake-blobs.test.mjs),
// and by tests that want the real client in the loop. Import this file BEFORE any module that imports
// @netlify/blobs (for example a function under netlify/functions), or the client keeps its 5 s retry delay.
import "./node-env-test.mjs";
import { getStore } from "@netlify/blobs";

export { getStore as realGetStore };

// getStore with the real client, pointed at the fake server. Same signature as getStore.
export const realGetStoreFor = (blobs) => (input, options) => {
  const opts = typeof input === "string" ? { ...options, name: input } : { ...input };
  return getStore({
    ...opts,
    siteID: blobs.siteID,
    token: blobs.token,
    edgeURL: blobs.edgeURL,
    uncachedEdgeURL: blobs.uncachedEdgeURL,
    fetch: blobs.fetch,
  });
};

// The environment context Netlify gives a function (NETLIFY_BLOBS_CONTEXT), pointed at the fake server.
// Setting globalThis.netlifyBlobsContext makes the plain getStore({ name }) in liveDeps() use it.
export const blobsContextFor = (blobs) => Buffer.from(JSON.stringify({
  siteID: blobs.siteID, token: blobs.token, edgeURL: blobs.edgeURL, uncachedEdgeURL: blobs.uncachedEdgeURL,
})).toString("base64");
