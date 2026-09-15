# 06：課金プランと無償枠の設計 — **M0の費用目標は $0**

> 本書が **プラン・上限・昇格トリガーの正本**。他の手順書（`00`〜`05`）はここを参照する。
> 方針：**M0〜M2前半は Workers Free と R2 無料枠内で $0 を目指す。** Workers Paid / WfP への加入は必要時まで見送る。R2 の従量課金契約は別途判断する。

> **2026-09-08 実測による訂正**：R2 は Workers Free とは別の利用申込みが必要。登録済み支払い方法を使う「月額 $0 ＋追加使用量」の条件を本人が承認し、有効化済み。無料枠を超えると課金されるため、$0 は請求のハード上限ではない。「支払い手段不要」「WfPだけが課金境界」という従来の説明は成立しない。[R2開始手順](https://developers.cloudflare.com/r2/get-started/)、[R2料金](https://developers.cloudflare.com/r2/pricing/)

---

## 1. 結論

| フェーズ | プラン | 月額 | 契機 |
|---|---|---|---|
| **M0 〜 M2前半** | **Workers Free＋R2無料枠** | **$0 目標**（2026-09-12 宣言） | R2は申込済。**唯一の課金経路はR2の無料枠超過**。GitHub は public のため Actions も $0 |
| M2後半 〜 M4 | Workers Paid | $5 | CPU・リクエスト・DO容量のいずれかが昇格トリガー（§5）に触れたとき |
| L3解禁時（実質 M5〜M6） | ＋ Workers for Platforms | ＋$25 | 最初に L3 server functions / Form B が必要になったとき |

Workers / WfP の基本料金だけを合計すると月 $30。R2などの追加使用量は別途課金されるため、請求総額の上限ではない。

**Builder Plane（CommandAgent）はそもそも Cloudflare 外**（企画書11章「Cloudflareに載せないもの」）。無料アームのローカル9B/MLXは自社Apple Siliconで動くため、生成コスト $0.0013/本 とインフラ $0 は独立に成立する。

---

## 2. コンポーネント別の無償プラン適合

| Musubiの構成要素 | Free | 制限 | M0で使う |
|---|---|---|---|
| host / gateway / data-api / spec-engine | ✅ | 100,000 req/日（UTC 0時リセット）・**1リクエストあたり CPU 10ms** | ✅ |
| app-do（SQLite DO ＋ WebSocket） | ✅ | SQLite型DOは 2025-04 から Free 可。**アカウント合計 5GB／1オブジェクト 1GB** | ✅ |
| D1（Control Plane） | ✅ | 5GB・日次の読み書き上限内 | ✅ |
| R2（bundle・写真） | 無料枠あり・別途申込 | Standard: 10GB-month・Class A 月100万回・Class B 月1,000万回。超過分は課金 | ✅ |
| Queues（Builder起動） | ✅ | 2026-02 から Free に追加。1日10,000オペレーション・全機能可（保持24時間／有償14日） | 器のみ |
| Cron Triggers（jobs） | ✅ | アカウント5個まで | ❌（M6） |
| Turnstile / Rate Limiting 基本 | ✅ | — | ❌（M4） |
| **Workers for Platforms（L3 / Form B）** | ❌ | **$25/月の有償プランのみ** | ❌ |
| Logpush | ❌ | 代替：**Workers Logs の無償枠** or D1イベントログ | 代替を使う |

> Queues の 1日10,000オペレーションは、生成キューなら **1日約3,000件相当**。MVPには十分すぎる。

---

## 3. なぜ課金境界がここまで後ろ倒しにできるのか

ユーザーコード実行に関する有償コンポーネント **Workers for Platforms** は、企画書12章の確定仕様——

> **「L1-L2ではコードを1行も生成しない」（宣言と証拠のみ）**

——により、**MVPの3アプリ（持ち物管理・割り勘・投票／すべてL2）は WfP を一切必要としない**。L4のUIウィジェットもクライアント側 sandboxed iframe で動くので WfP不要。WfPが要るのは **L3 server functions** と **Form B**（企画書8章・13章）からで、これはロードマップ上 M5〜M6 の話。

L1-L2 の依頼を L3 に昇格させないラダーの機械強制（企画書12章）により WfP の有効化を見送れる。ただし $0 の維持には、R2などの使用量を無料枠内に収めることも必要。

---

## 4. 注意点3つと、M0での設計上の対応

### 4.1 【最タイト】CPU 10ms / リクエスト

**対応：host を SSR ではなく SPAシェル配信にする。**

企画書の前提——**招待制（SEO無関係）・PWA・リアルタイム**（11章「Next.jsの主戦場が不要」）——により、SSRは元々要らない。

| 変更前の想定 | 無償プラン前提の確定 |
|---|---|
| host = TanStack Start の SSR Worker | **host = Workers Static Assets（SPAシェル）＋ 最小のWorker** |
| ページ表示ごとに Worker が起動 | **静的アセットの配信は Worker を起動しない** |

これには副次効果がある：**Workers Static Assets へのリクエストは無料・無制限で、100k req/日 を消費しない。** ページロードのコストがゼロになり、日次予算をAPI呼び出しだけに使える。

Spec Engine の computed 評価は AST上限つき設計（企画書8章 L2）なので 10ms に収まる想定。**ただし M1 で実測する**（M0 の health chain と同じく Workers Analytics の cpuTime で測る。計測スクリプトは `infra/scripts/measure-free-tier.ts`・§7.1）。

> ⚠️ **要確認（最優先・§7 の #1）**：Service Bindings のチェーン（host→gateway→data-api）で **CPU時間が各Workerに独立して配分されるのか、リクエスト全体で合算されるのか**。合算なら3ホップ構成は 10ms で窮屈になる。**M0の最初の実測項目にする**（`03` §5・計測スクリプトで Workers Analytics を読む）。合算だった場合の退路は、gateway と data-api の統合ではなく **Workers Paid $5 への昇格**（統合すると企画書9章「Data APIが唯一の権限強制点」が崩れる。**アーキテクチャを課金プランに売らない**）。
>
> **2026-09-14 実測（§7 #1・§7.1）**：Analytics の cpuTime は Worker ごとに別に記録される。上限の判定がどちらの単位かは一次情報に書かれていないが、**合算の上界（3 Worker の max の和）でも 6.51 ms・5.28 ms**（2回）で、M0 の health chain はどちらの解釈でも 10 ms に収まる。gateway に認可（M2）が入ったら測り直す。
>
> **2026-09-14 追記（Issue #26・§7.2）— 上の「どちらの解釈でも収まる」は、続けて送った 20 回についてだけ正しかった。**
> 期間の最大を読むと、production を作った直後の単発の `/healthz` 1 回で **data-api が単体で 11.30 ms**（エラーなし）、チェーン合計 16.47 ms だった。
> **production は独立でも合算でも、05 §3.5 の「余裕 3 ms」の線を割っている**（staging は合算のときだけ割る。間を空けた単発のリクエストでチェーン合計 6.16〜7.53 ms）。
> 昇格トリガー P-1（エラーの件数）には触れていないので、昇格するかは監督側（人）が決める（§7.2・§8）。

### 4.2 100k req/日

- ドッグフーディング（M3・5〜10コミュニティ）には余裕
- **M4公開時には足りない** → 公開前に Workers Paid（1,000万リクエスト）へ

> ⚠️ **要確認（§7 の #2）**：Service Binding 経由の呼び出しが**課金リクエストとして別カウントされるか**。別カウントなら1 API呼び出し＝3リクエスト（host/gateway/data-api）となり、実効予算は 33k/日 になる。§4.1 の静的配信化と合わせて、**M0で実測する**（`03` §5・計測スクリプト）。
>
> **2026-09-14 実測（§7 #2・§7.1）**：Analytics の requests では **gateway・data-api も host と同じくらい数えられる**（host への 1 回が 3 requests）。請求は Standard では最初の1回だけ（一次情報）だが、**Free の 100k/日 がどちらで数えるかは一次情報に書かれていない**。だから予算は別カウント（実効 33k/日）で見積もる（P-2 の閾値は変えない。Workers Analytics のアカウントの合計は Service Binding の先も含むので、保守側に数えることになる）。

### 4.3 staging / production の無償枠の食い合い

Free の上限は **アカウント単位**。同一アカウントに3環境を置くと、CIのスモークやdev作業が production の 100k/日 を削る。

**対応：アカウントを分ける**（→ 🧑 H-14）。**2026-09-12 に案A で決定**：アカウント①（既存）= dev + staging ／ アカウント②（新規）= production。

| 案 | 構成 | 評価 |
|---|---|---|
| **A（推奨）** | アカウント①= dev + staging／アカウント②= production | prod の枠を絶対に汚さない。**移行コストは今だけゼロ** |
| B | 3環境とも1アカウント | 単純。ただし後から prod を分離すると **D1/R2/DO のデータ移行が発生する** |
| C | 3環境で3アカウント | 分離は最強だがトークン・state管理が3倍。M0には過剰 |

**A を採用した理由**：IaC化済みなら環境の再現コストはゼロだが、**production を後から別アカウントへ動かすのはデータ移行**になる。分けるなら production が空の今しかない——という理由で 2026-09-12 に確定した。

> **2026-09-12 実測で確認済み**：Cloudflare は1ログイン（1メールアドレス）で複数アカウントを保持できる。ダッシュボードのアカウント切替メニューに「＋ Create Account」がある。**エイリアスメールは不要**で、2FA もログイン単位のため1回で足りる。

---

## 5. プラン昇格トリガー（**事前宣言**）

企画書16章の「事前宣言→実測→清算」を課金判断にも適用する。**以下に触れたら、議論せず即上げる。**「まだいける」で粘って障害を出すのが最悪の結果。

> **✅ 2026-09-12：P-1〜P-6・W-1・W-2 の8件すべてを本人が承認（H-13 / [`00b-decisions.md`](./00b-decisions.md) D-3）。**
> **即決者：Kewton（本人）。1人開発につき、抵触を確認した時点で即決し議論しない。**

### Workers Paid（$5/月）へ

| # | トリガー | 監視方法 |
|---|---|---|
| P-1 | CPU超過エラー（`Worker exceeded CPU time`）が **7日間で1件でも**発生 | Workers Logs のエラー率アラート |
| P-2 | 日次リクエストが **50,000/日（上限の50%）** を超えた日が3日連続 | Workers Analytics |
| P-3 | DO ストレージが **2.5GB（上限の50%）** を超えた | 週次チェック |
| P-4 | D1 の日次読み取り／書き込みが上限の50%を超えた | 週次チェック |
| P-5 | **M4（公開）の着手が決まった** | ロードマップ上の判断（無条件で先に上げる） |
| P-6 | Workers Logs の保持期間が短くて障害調査が詰まった | 定性判断・1回でも起きたら |

### ＋ Workers for Platforms（$25/月）へ

| # | トリガー |
|---|---|
| W-1 | 最初に **L3 server functions** を必要とするアプリ要求が出た（＝promotion_decision が正当に通った初回） |
| W-2 | **Form B**（フルアプリ生成）を実装する（M7・テンプレートマーケット） |

> **W-1 は「L3が必要になった」ことの検知が前提。** 企画書12章のラダー機械強制が promotion_decision を記録しているので、**その記録件数がそのまま WfP 昇格の先行指標になる**。M2で計測基盤を作るとき、この指標をダッシュボードに入れる。

### ＋ ブランチ保護の強化へ

課金ではないが、**同じ「事前宣言」の型で切替条件を固定しておく**。

| # | トリガー | 変更内容 |
|---|---|---|
| **B-1** | **M3（ドッグフーディング）に着手した**＝実データが入る | `main` の保護を `enforce_admins: true` にする |

**2026-09-12 承認済み。** 現在は `false`（管理者は bypass 可）。1人開発で管理者＝唯一の開発者のため、
PR必須もCIゲートも実質は自己規律である。M0〜M2 はインフラの試行錯誤が多く PR の往復が純粋な摩擦になる
一方、壊して困るデータがまだ無いので `false` を許容する。**実データが乗った時点で事故コストが跳ね上がる**ため、
そこで例外なくCIを通す側へ倒す。

```bash
gh api -X PATCH repos/Kewton/Musubi/branches/main/protection/enforce_admins -X POST
```

> 緊急時は保護を一時的に外す操作が要る。**外したら Issue に理由を残す**（`01-repo-bootstrap.md` §8.1）。

### 5.1 週次チェック（**毎週月曜・5分**）

H-13 で決めた確認日。**見るのは5点だけ。** 1つでも触れていたら、その場で即決して上げる。

| # | 見るもの | どこで | 触れていたら |
|---|---|---|---|
| 1 | **R2 の使用量**（保存容量・Class A/B オペレーション） | R2 → 対象バケット → Metrics | **唯一の課金経路。** 無料枠に近づいたら原因を特定する（$0 が破れるのはここだけ） |
| 2 | 日次リクエスト数 | Workers Analytics（アカウント①・②の両方） | **P-2**：50,000/日 超が3日連続 → Workers Paid |
| 3 | CPU超過エラー（`Worker exceeded CPU time`） | Workers Logs のエラー | **P-1**：7日間で1件でも → Workers Paid |
| 4 | DO ストレージ | Workers & Pages → Durable Objects | **P-3**：2.5GB 超 → Workers Paid |
| 5 | D1 の日次読み書き | D1 → 対象DB → Metrics | **P-4**：上限の50%超 → Workers Paid |

**アカウント①と②の両方を見ること。** 分離したので、片方だけ見ると見落とす。

**2〜5 はスクリプト1本で両方のアカウントを読める**（2026-09-14・Issue #26。§7.2）。終了コード 2 なら触れている。1 の R2 はダッシュボードで見る。

```bash
pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts     # ①と②の、今日（UTC）までの 7 日
```

> 3 の CPU 超過は、Workers Logs ではなく **Workers Analytics の `exceededResources`** で見る。Free の Workers Logs は 3 日しか残らず（§7 #8）、P-1 の「7日間」を覆えない。
> `exceededResources` は CPU 時間のほか起動時間・Free の上限でも付く（一次情報）ので、CPU 超過の上界として数える。

> M0 のうちはトラフィックがほぼゼロなので、実質 R2 の1点だけを見ることになる。**習慣を先に作っておくのが目的**であり、数字が動き始める M2〜M3 で効いてくる。

---

## 6. 無償枠を M0 で無駄に食わないための規律

M0はほぼトラフィックゼロだが、**CI が枠を食う**。以下を守る。

| 規律 | 理由 |
|---|---|
| スモークは **デプロイ後1回だけ**。定期ポーリングしない | 5分おきのヘルスチェックは 288 req/日 × 環境数を食う |
| dev/staging と production を**別アカウント**に（§4.3 案A） | CIの試行錯誤が prod 枠に届かない |
| R2 の `_probe` オブジェクトは**上書き（同一キー）**にする | Class A オペレーションを増やさない |
| `terraform plan` は `infra/**` 変更時のみ | API呼び出しの節約（Cloudflare API にもレート制限がある） |
| Logpush を使わない。**Workers Logs（無償枠）＋ `observability.enabled: true`** | Logpush は有償 |

---

## 7. 要確認リスト（M0で一次情報／実測により確定させる）

| # | 項目 | 確定方法 | 期限 | 結果 |
|---|---|---|---|---|
| 1 | **Service Bindings で CPU時間は各Worker独立か合算か** | 計測スクリプトで Workers Analytics の cpuTime を読む（§7.1） | M0 | **2026-09-14 実測・/healthz 20 回 × 2**。Analytics の cpuTime は **Worker ごとに別に記録**される（host の1回あたり 0.67・0.64 ms は gateway＋data-api の 3.02・3.07 ms より小さい＝下流を含まない）。上限の判定単位は一次情報に記載なし（未確定）。**合算の上界（max の和）6.51 ms・5.28 ms、余裕 3.49 ms・4.72 ms**。合算でも収まるので M0 では決めなくてよい。**→ 期間の最大では覆った（§7.2）**：production の data-api が単体で 11.30 ms（エラーなし）。独立でも余裕 3 ms を割るので、判定単位によらず人の判断が要る |
| 2 | **Service Binding 呼び出しは課金リクエストとして別カウントされるか** | Analytics のリクエスト数と実呼び出し数を突き合わせ（§7.1） | M0 | **2026-09-14 実測・/healthz 20 回 × 2**。Analytics の requests は host 27・20、gateway 20・26、data-api 20・17（サンプリングの推定値）＝**Analytics 上は別カウント**（host への 1 回が 3 requests）。請求は Standard では1回（一次情報）。Free の 100k/日 の数え方は一次情報に記載なし → **別カウントで見積もる**（§4.2） |
| 3 | 1ログインで複数 Cloudflare アカウントを保持できるか | ダッシュボードで実際に作ってみる | 🧑 H-14 | — |
| 4 | Workers Static Assets へのリクエストが 100k/日 を消費しないこと | Analytics で確認（§7.1） | M0 | **2026-09-14 実測・ページ 20 回 × 2**（`/` 10 回＋深いリンク 10 回）。**Worker の起動 0 回・0 回**、Static Assets の requests は 22・11 回と記録 → **消費しない**（確定。一次情報とも一致） |
| 5 | Free で Workers Custom Domain / Routes が使えるか（🧑 H-04 後） | ドメイン取得後に確認 | M1 | — |
| 6 | Queues の Free 提供条件（2026-02 追加の現行仕様） | 一次情報 | M1 | — |
| 7 | Free の subrequest 上限（1リクエストあたり）と本構成の消費数 | ドキュメント＋実測 | M0 | **2026-09-14・一次情報＋コード＋Analytics**。Free は **1回の起動あたり 50**（Cloudflare のサービスへは 1,000）。Service Binding の呼び出しも呼び出し元の subrequest に数え、1 リクエストで起動できる Worker は 32 まで。`/healthz` の消費はコードで数えて **host 1（→ gateway）・gateway 1（→ data-api）・data-api 5（D1 1・R2 3・DO 1）、チェーン合計 7** → 全部を 50 に数えても余裕 43。Analytics の `sum.subrequests` は3つとも1回あたり 1.00（binding の呼び出しの一部はこの欄に出ない。§7.2）。gateway に認可（M2）が入ったら数え直す |
| 8 | Workers Logs の無償保持期間 | 一次情報 | M0 | **2026-09-14・一次情報**。Free は **3 日**（書き込みは1日 200,000 件まで）。Paid は 7 日（月 2,000 万件込み）。P-1 の「7日間」を覆えないので、P-1 は Analytics で見る（§5.1・§7.2） |

### 7.1 無償枠の実測（2026-09-14・Issue #25）

**測り方。** 計測スクリプト `infra/scripts/measure-free-tier.ts` を手元から staging（アカウント①）に向けて回した。
デプロイ直後の貫通スモーク（`pnpm smoke`）には入れていない（Analytics は数分遅れて反映されるので、`04` §4 の 10分の線を削る）。

```bash
pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts          # 送って、反映を待って、判定する
pnpm exec tsx --env-file=.env infra/scripts/measure-free-tier.ts \
  --pages-window <since>/<until> --healthz-window <since>/<until>          # 送らずに、前の窓を読み直す
```

- **CPU 時間は Worker の中では測れない。** Workers の時計（`performance.now`・`Date.now`）は I/O のときにしか進まない。だから正は Workers Analytics の invocation の cpuTime
- 送るのは staging の host への GET だけで、**1回の実測で 40 回**（上限 50）：`/` と深いリンク（`/communities/c1/apps`）を 10 回ずつ、8 秒空けて `/healthz` を 20 回。
  ページはブラウザのページ遷移と同じヘッダ（`sec-fetch-mode: navigate`）で送る（Node の fetch はこのヘッダを `cors` に書き換えるので、`node:https` で送る）
- 資格情報は `.env` の CI 用トークン。**読み取りだけ**（workers.dev のサブドメインの読み取り・GraphQL の読み取り）。宛先の URL は API から組み立て、表示もファイルへの書き込みもしない
- ページの窓と `/healthz` の窓を応答の Date ヘッダから作り、Analytics を窓ごとに読む。2回続けて同じ値になったら反映済みとみなす
- 出力は回数・ミリ秒・判定・窓の時刻だけ

**使ったデータセットと欄**（アカウント単位。単位は GraphQL のスキーマの説明で確かめた）

| 何を | データセット | 欄 | 出典 |
|---|---|---|---|
| Worker ごとの起動の回数 | `workersInvocationsAdaptive` | `sum.requests`（`dimensions.scriptName` で分ける） | [Querying Workers Metrics with GraphQL](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) |
| CPU 時間 | 同上 | `sum.cpuTimeUs`・`max.cpuTime`・`quantiles.cpuTimeP50/P99`（すべてマイクロ秒） | 同上・スキーマ |
| サンプリング | 同上 | `avg.sampleInterval`（1 ならサンプリングなし） | スキーマ |
| Static Assets が返したリクエスト | `workersAssetsRequestsAdaptiveGroups` | `sum.requests`（`hostname` で host に絞る。`dimensions.statusCode` を選ぶ） | スキーマ |
| 権限 | — | Account Analytics: Read | [Configure an Analytics API token](https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/) |

**結果**

| | 1回目（09:14 UTC） | 2回目（09:28 UTC） |
|---|---|---|
| ページ 20 回 → Worker の起動（host・gateway・data-api） | 0・0・0 | 0・0・0 |
| ページ 20 回 → Static Assets の requests | 22 | 11 |
| `/healthz` 20 回 → requests（host・gateway・data-api） | 27※・20・20 | 20・26※・17 |
| CPU max（host・gateway・data-api） | 1.56※・1.18・3.77 ms | 1.16・1.30※・2.83 ms |
| CPU p50（同） | 0.59・0.61・2.28 ms | 0.58・0.72・2.10 ms |
| CPU 1回あたりの平均（同） | 0.67・0.63・2.39 ms | 0.64・0.90・2.17 ms |
| **チェーン合計の上界（max の和）／余裕** | **6.51 ms ／ 3.49 ms** | **5.28 ms ／ 4.72 ms** |
| チェーン合計の平均 | 3.70 ms | 3.70 ms |
| errors | 0 | 0 |

※ サンプリングあり（`sampleInterval` 1.5）。回数・和は重みを掛けた推定値で、max・分位は取りこぼし得る。
1回目の `/healthz` は約 70 分ぶりの呼び出しで、コールドスタートを含み得る。

**読み方と、残る不確かさ**

- **#4（Static Assets）は確定。** Worker の起動は2回とも 0。一次情報も「Requests to static assets are free and unlimited」「`run_worker_first` に当たるリクエストは常に Worker を起動する」と書く（[Static Assets の Billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)）。host の `run_worker_first` は `/api/*` と `/healthz` だけ（`03` §2）
- **#2（Service Binding）は「Analytics 上は別カウント」までが実測。** 一次情報の料金は、Standard では Service Binding の呼び出しを「最初の Worker の1リクエスト＋両 Worker の CPU 時間の合計」で請求する（[Pricing: Service bindings](https://developers.cloudflare.com/workers/platform/pricing/#service-bindings)）。
  Free の 1日 100,000 リクエスト（[Limits: Daily requests](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)）がどちらで数えるかは書かれていない。Service Binding の先の呼び出しは、呼び出し元の subrequest の上限にも数えられる（[Service bindings: Limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits)。§7 #7）
- **#1（CPU）は「記録は Worker ごと」までが実測。** 上限は料金表では「10 milliseconds of CPU time per invocation」、制限表では「CPU time per HTTP request: 10 ms」で、I/O の待ちは数えない（[Limits: CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)）。
  Service Binding のチェーンで合算して判定するかは書かれていない。合算の上界でも余裕が 3.49 ms あるので、M0 の health chain は判定単位によらず収まる
- **回数は揺れる。** Adaptive のデータセットは、20 回ていどでもサンプリングされたり（20 回が 27 回）、重み 1 のまま取りこぼしたり（17 回）した。
  スクリプトは「0 か、送った数くらい（半分から倍）か」で判定する。P-2 で見る日次リクエストも、同じ Adaptive の推定値である
- CPU の分位は、上限を少し超えて見えてもエラーにならないことがある（上限未満のリクエストの余りを繰り越す仕組み。[Workers Metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)）

**Worker 名が `__unknown__` で返った件（Issue #25 の調査）**

- 観測：staging の3つの Worker は 2026-09-14 08:01 UTC ごろ `deploy-staging` で初めて作られた。`workersInvocationsAdaptive` の `scriptName`（と `scriptTag`・`environmentName`）は、08:50〜09:14 UTC の読み取りで `__unknown__` だった（`scriptVersion` だけ入っていた）。**09:33 UTC には名前が入り**、それより前の窓（08:02 のスモーク）の行にも遡って入った
- 同じトークン・同じデータセット・同じ欄で、アカウント①に以前からある Worker の名前は読めた
- だから原因は**反映の遅れ**（新しい Worker の名前は、作ってから 73 分後にはまだ入らず、92 分後には入っていた）。**権限・データセット・欄の選び方ではない**。トークンは作っていない
- スクリプトは、名前の無い起動がある窓を判定しない（exit 2）。時間を空けて、出力された窓で読み直す

**反映の遅れ（ほかに見えたもの）**：`workersInvocationsAdaptive` の回数は送ってから約 1 分で読めた。`workersAssetsRequestsAdaptiveGroups` は、
`dimensions` を選ばずに `hostname` で絞った集計が約 9 分空のままで、`statusCode` を選ぶと約 1.5 分で読めた。

> **数値は変わる。** 本書は「M0着手時点の前提」であり、**上限に近づいたときは必ず一次情報を引き直す**。この表の値をコードやアラート閾値にハードコードしない。

### 7.2 無償枠の集計と昇格トリガーの判定（2026-09-14・Issue #26）

**測り方。** 集計スクリプト `infra/scripts/free-tier-report.ts` を手元から、アカウント①と②の両方に向けて回した。
**実環境への操作は Workers Analytics（GraphQL）の読み取りだけ**で、Worker へのリクエストは送らない（§7.1 の計測スクリプトとの違い）。§5.1 の週次チェックの 2〜5 にもそのまま使う。

```bash
pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts                                          # ①と②の、今日（UTC）までの 7 日
pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts --since 2026-09-08 --until 2026-09-14    # 期間を指定する（31 日まで）
pnpm exec tsx --env-file=.env infra/scripts/free-tier-report.ts --account 1                               # ①だけ
```

- 資格情報は `.env` の CI 用トークン（①は `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`、②は `CLOUDFLARE_API_TOKEN_PROD`・`CLOUDFLARE_ACCOUNT_ID_PROD`）。1 アカウントにつき GraphQL を 1 回読むだけ
- 出すのは日付・回数・ミリ秒・バイト数・判定だけ。Account ID・DO の namespace の ID・Musubi 以外の Worker の名前は出さない
- 終了コード：**0** = P-1〜P-4 に触れていない／**1** = 失敗／**2** = 触れた（§5：議論せず即上げる）。CPU の余裕が 3 ms 未満なら、終了コードとは別に「注意」を出す
- **日次リクエスト・DO の容量・D1 の行はアカウント単位の上限**なので、Musubi 以外の Worker も合計に入れる（アカウント①には以前からの Worker がある。期間中の起動は無かった）。**CPU 時間は起動ごとの上限**なので Musubi の Worker だけを見る
- 上限の値は一次情報からスクリプトの `FREE_LIMITS` に出典つきで写した。一次情報が変わったらそこを直す（テストが値を固定している）
- R2（§5.1 の 1）は読まない。ダッシュボードで見る。課金額は API で読めない

**使ったデータセットと欄**（アカウント単位。欄と単位は GraphQL のスキーマで確かめた。`settings` は maxDuration 32 日・notOlderThan 90 日）

| 何を | データセット | 欄 | 見るもの |
|---|---|---|---|
| 日次リクエスト | `workersInvocationsAdaptive` | `sum.requests`（`dimensions` の `date`・`scriptName`・`status` で分ける） | P-2 |
| 上限超過の起動 | 同上 | `status` が `exceededResources` の `sum.requests` | P-1 |
| CPU 時間 | 同上 | `max.cpuTime`・`sum.cpuTimeUs`（マイクロ秒）、`avg.sampleInterval` | 余裕（05 §3.5） |
| subrequests | 同上 | `sum.subrequests` | §7 #7 |
| DO の保存容量 | `durableObjectsSqlStorageGroups`（＋ KV 型の `durableObjectsStorageGroups`） | `max.storedBytes`（日 × namespace の max を、日ごとに足す） | P-3 |
| D1 の読み書き | `d1AnalyticsAdaptiveGroups` | `sum.rowsRead`・`sum.rowsWritten` | P-4 |

**なぜ P-1 を Workers Logs ではなく Analytics で見るか。** Free の Workers Logs は 3 日しか残らない（§7 #8）ので、P-1 の「7日間」を覆えない。Analytics は 90 日遡れる。
`exceededResources` は「Worker exceeded runtime limits」で、一次情報は「The most common cause is excessive CPU time, but is also caused by a Worker exceeding startup time or free tier limits」と書く。**だから CPU 超過の上界として数える**（0 件なら CPU 超過も 0 件）。

**結果**（期間 2026-09-08〜2026-09-14 UTC。読んだのは 09-14 16:14 UTC。09-14 は途中までの値）

| | アカウント①（dev + staging） | アカウント②（production） | 線（§5） | 判定 |
|---|---|---|---|---|
| 最大日次リクエスト | **217** req/日（09-14。すべて staging） | **30** req/日（09-14） | 50,000/日 が3日連続 | **P-2 触れていない** |
| 上限超過の起動（`exceededResources`） | **0** | **0** | 7日間で1件 | **P-1 触れていない** |
| DO の保存容量（最大の日） | **0.02 MB**（24,576 bytes） | **0.02 MB**（24,576 bytes） | 2.5 GB | **P-3 触れていない** |
| D1 読み取り／書き込み（最大の日） | **8 ／ 11** 行 | **5 ／ 11** 行 | 2,500,000 ／ 50,000 行/日 | **P-4 触れていない** |
| CPU の回数（host・gateway・data-api） | staging 74・75・68（dev は起動なし） | 14※・9・7 | — | — |
| CPU max（同） | 1.85※・1.99※・**5.68** ms | 3.30※・2.34・**11.30** ms | 10 ms/起動 | ⚠️ production の data-api が単体で超えた（エラーなし） |
| CPU 1回あたりの平均（同） | 0.79・0.89・2.61 ms | 1.76・1.83・6.09 ms | — | — |
| チェーン合計の上界（max の和）／余裕 | **9.52 ms ／ 0.48 ms** | **16.94 ms ／ −6.94 ms** | 05 §3.5：余裕 3 ms | ⚠️ 両方とも割った |
| subrequests（Analytics・1回あたり） | 1.00・1.00・1.00 | 1.00・1.00・1.00 | 50/起動 | §7 #7 |

※ サンプリングあり（回数は推定値、max は取りこぼし得る）。

**単発のリクエストが重い**（同じデータセットを `datetimeMinute` で分けて手で読んだ。1分に3つの Worker が1回ずつしか起動していない分＝`/healthz` 1 回）

| 環境 | 時刻（UTC） | host・gateway・data-api の cpuTime | チェーン合計 |
|---|---|---|---|
| staging | 08:02・09:54・10:04・11:23・11:32・14:10 の6回 | data-api は 3.22〜4.23 ms | **6.16〜7.53 ms**（余裕 2.47〜3.84 ms） |
| production | 14:25（`deploy-production` の実行中。14:22〜14:26） | 1.42・1.72・3.82 ms | 6.96 ms |
| production | 14:36 | 3.30・1.87・**11.30** ms | **16.47 ms** |

§7.1 の、8 秒おきに 20 回続けて送った実測（チェーン合計の上界 6.51・5.28 ms、data-api の max 3.77・2.83 ms）より重い。
間を空けた単発のリクエストは data-api が重く、production を作った直後はさらに重かった（原因は切り分けていない）。

**読み方**

- **昇格トリガー P-1〜P-6 のいずれにも触れていない。** P-1〜P-4 は上の表。P-5 は M4 の着手が決まっていない（M0 の途中）。
  P-6 は「保持期間が短くて障害調査が詰まった」記録が 00e・Issue に無い。**議論せず即上げる運用（H-13）は発動しない**
- **ただし CPU 時間は、05 §3.5 の「余裕 3 ms 未満なら Workers Paid」の線を割っている。**
  05 §3.5 の処置は「F-1 が合算だった場合」の宣言で、F-1 は未確定のまま（§7 #1）。ところが production の data-api は**単体で 11.30 ms** なので、
  判定が Worker ごとでも余裕は −1.30 ms、合算なら 1 回のリクエストで −6.47 ms。**どちらの解釈でも、昇格する側に入っている**
- 上限を超えた記録がエラー（`exceededResources`）になっていないのは、一次情報が書く「上限未満のリクエストの余りを繰り越す仕組み」で起こり得る（[Workers Metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)）。
  **繰り越しに頼っている状態は、トラフィックが増えれば P-1 のエラーになり得る**
- **昇格するかは監督側（Kewton）が決める。** ワーカーは決めない（課金を伴い、宣言の条件〈合算〉と実測〈未確定・単体でも超過〉がずれているため）。
  退路はアーキテクチャではなく課金（§4.1：gateway と data-api を統合しない）
- 回数は Adaptive の推定値で揺れる（§7.1）。閾値（5 万回・2.5 GB・250 万行／5 万行）とは 2 桁以上離れているので、P-2〜P-4 の判定は揺れの影響を受けない

**出典**（2026-09-14 に確認）

- 上限：[Workers Limits: Daily requests](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)（100,000/日・00:00 UTC）、[CPU time](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)（10 ms）、
  [Subrequests](https://developers.cloudflare.com/workers/platform/limits/#subrequests)（Free 50/起動・Cloudflare のサービスへは 1,000）、
  [Service bindings: Limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/#limits)（呼び出し元の subrequest に数える・1 リクエストで Worker の起動は 32 まで）
- DO：[Durable Objects Pricing: SQLite storage backend](https://developers.cloudflare.com/durable-objects/platform/pricing/#sqlite-storage-backend)（Free 5 GB 合計）、[Metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)
- D1：[D1 Pricing: Billing metrics](https://developers.cloudflare.com/d1/platform/pricing/#billing-metrics)（Free 読み取り 500 万行/日・書き込み 10 万行/日）、[Metrics and analytics](https://developers.cloudflare.com/d1/observability/metrics-analytics/)
- Workers Logs：[Workers Logs: Pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing)（Free 3 日・1日 200,000 件）
- invocation の status：[Workers Metrics: Invocation statuses](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#invocation-statuses)

---

## 8. 清算（M0完了時に記入）

```
プラン清算 — 記入日: 2026-09-15（Analytics は 2026-09-08〜2026-09-14 UTC を 09-14 16:14 UTC に読んだ。§7.2）

  実際の課金額        宣言 $0     実測 $0（2026-09-15 に所有者がダッシュボードの Billing で確認。API では読めない）
                                  判定 達成
  最大日次リクエスト   （記録）    217 req/日（アカウント①・staging・09-14）／ 30 req/日（アカウント②・09-14）
  観測された最大CPU    （記録）    11.30 ms（production の data-api・単体・エラーなし）← 10ms に対する余裕 −1.30 ms
                                  チェーン合計の上界 16.94 ms（production）・9.52 ms（staging）← 合算なら余裕 −6.94 ms・0.48 ms
                                  ↳ 11.30 ms は production の初回デプロイ直後の最初のリクエスト（2026-09-14 14 時台の 7 回のうち1回）。
                                    落ち着いた状態の再測（2026-09-15・production・/healthz 20 回。先に 5 回温めて 60 秒空けた）：
                                    Worker 単体の max は data-api 5.20・gateway 2.05・host 2.11 ms（エラー 0）→ 単体の余裕 4.80 ms。
                                    3 Worker の max の和 9.36 ms（合算の上界の余裕 0.64 ms）。1回あたりの平均の和は 4.80 ms
  DO ストレージ        （記録）    0.02 MB（①・②とも 24,576 bytes）
  要確認 #1 の結論     未確定（Analytics の記録は Worker ごと。上限を Worker ごとに判定するか合算するかは一次情報に無い）
  要確認 #2 の結論     別カウントされる（Analytics 上。Free の 100k/日 の数え方は一次情報に無いので、別カウントで見積もる）
  昇格トリガー抵触     なし（P-1〜P-6。P-1 の exceededResources は①②とも 0 件）
  05 §3.5 の線        初回デプロイ直後の1回で割った。落ち着いた状態では単体で割らず、合算の上界（max の和）では割る
                      → 2026-09-15 所有者の判断：**昇格しない**。F-1（合算か独立か）が未確定で、合算の宣言は発動条件を満たしていない。
                        週次チェック（§5.1）で CPU 時間の max を見続け、F-1 が確定したとき・gateway に認可が入ったとき（M2）に測り直す
```
