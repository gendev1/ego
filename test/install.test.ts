// pi-durable's Session tells a bad request from a broken storage with `instanceof StorageRequestError`. If
// pi-durable-cockroach loaded a pi-durable of its own, that check would fail and one bad read would end the whole
// session. `.npmrc` (install-links) installs the package as a copy without its own node_modules; this keeps it so.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const PACKAGE: string = "pi-durable-cockroach";
const installed = await import(PACKAGE).then(
    () => true,
    () => false,
);

test.skipIf(!installed)("pi-durable-cockroach uses ego's own pi-durable, not a copy of its own", () => {
    const fromEgo = createRequire(import.meta.url).resolve("@earendil-works/pi-durable");
    const fromPackage = createRequire(fileURLToPath(import.meta.resolve(PACKAGE))).resolve(
        "@earendil-works/pi-durable",
    );

    expect(fromPackage).toBe(fromEgo);
});
