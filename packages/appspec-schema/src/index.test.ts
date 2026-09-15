import { describe, expect, it } from "vitest";
import { APPSPEC_SCHEMA_VERSION, PACKAGE_NAME } from "./index.js";

describe("appspec-schema", () => {
  it("パッケージ名が正本の名前と一致する", () => {
    expect(PACKAGE_NAME).toBe("@musunest/appspec-schema");
  });

  it("スキーマバージョンが宣言されている", () => {
    // M1 で pins/commandagent.json の appspec_schema.version と突き合わせる
    expect(APPSPEC_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
