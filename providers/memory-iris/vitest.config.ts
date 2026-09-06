import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const providerDirectory = fileURLToPath(new URL(".", import.meta.url));

export default {
  resolve: {
    // Host contracts and testkit are same-repo `link:` dependencies, so the tests
    // run against their sources — that is the co-evolution the intermediate
    // distribution state (ADR-0020 §11.2) exists to preserve.
    //
    // `@iris-memory/sdk` is deliberately NOT aliased: it is a cross-repo
    // dependency and must resolve through the registry-installed package, so the
    // tests exercise the same resolution path a consumer gets.
    alias: {
      "@bellis/contracts/memory": resolve(
        providerDirectory,
        "../../packages/contracts/src/memory/index.ts",
      ),
      "@bellis/testkit": resolve(providerDirectory, "../../packages/testkit/src/index.ts"),
    },
  },
  test: { include: [resolve(providerDirectory, "test/**/*.test.ts")] },
};
