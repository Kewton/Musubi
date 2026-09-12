// ★正本。entities 由来の型の源泉（企画書13章 Template as Contract）
// M0 では中身を持たない。依存の向きと型の伝播経路だけを固定する。

export const PACKAGE_NAME = "@musubi/appspec-schema" as const;

/** AppSpec スキーマのバージョン。pins/commandagent.json の appspec_schema.version と対応させる。 */
export const APPSPEC_SCHEMA_VERSION = "0.0.0-m0" as const;
