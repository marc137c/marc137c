// @netlify/blobs reads NODE_ENV once, when it is first evaluated: "test" makes its retry delay 1 ms instead
// of 5 s. Import this module before anything that imports @netlify/blobs (real-blobs.mjs does).
process.env.NODE_ENV = "test";
