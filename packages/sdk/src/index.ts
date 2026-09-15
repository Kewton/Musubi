// @musubi/sdk — データ・通知への唯一の扉
// M0 では中身を持たない。依存の向きだけを固定する（01-repo-bootstrap.md §3.2）。

export const PACKAGE_NAME = "@musubi/sdk" as const;

// 否定試験（#18 C-4）：わざと型を合わせない。CI が落ちてマージがブロックされることを確かめたら PR を閉じる
export const _NEGATIVE_TEST_TYPE: number = "not a number";
