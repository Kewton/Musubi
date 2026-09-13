# D1 マイグレーション（`CONTROL_DB`）

Control Plane の D1（`musubi-<env>-control`）のスキーマを変える手順と、**変えてよい形の規律**。
手順書は `workspace/mvp/m0/03-workers-and-bindings.md` §7 と `04-cicd.md` §4〜§6。

> **対象は D1 だけ。** アプリのデータは Durable Object（SQLite）にあり、その migration は
> `wrangler.jsonc` の `migrations`（`03` §4）で扱う。ここには書かない。

**いちばん大事なこと**：D1 に down migration は無い。当てた migration を外す操作は存在しない。
だから「戻す」はコードの側で行い、スキーマは**1つ前のコードが動く形でしか変えない**（§4）。

---

## 早見表

| やりたいこと | どうする |
|---|---|
| migration を書く | §1.2 |
| 手元の DB に当てる | §2.1（`--local`） |
| staging / production に当てる | **CD が当てる。手で当てない**（§3） |
| dev の実物に当てる | §2.2（`infra:sync` で `database_id` を書き戻した後だけ） |
| 列・表を消す、改名する、制約を締める | §4.4 の2段階リリース。**単発で出さない** |
| 当てたものを戻したい | §5 |

コマンドはすべて**リポジトリ直下**で、この形で打つ。

```bash
pnpm exec wrangler d1 migrations <create|list|apply> CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc [--local|--remote]
```

`--env` も `--config` も省かない。`--config` を省くと設定ファイルが見つからずに落ちる。
`--env` を省くと `CONTROL_DB` の設定を拾えず、data-api 直下の `migrations/`（存在しない）を探して落ちる
（どちらも当たらない側に倒れる。2026-09-14 実測・wrangler 4.131.1）。

---

## 1. 仕組み

### 1.1 SQL は control-plane、当てるのは data-api の設定（2026-09-14 決定・#12）

| | 置き場 | 理由 |
|---|---|---|
| SQL | `packages/control-plane/migrations/NNNN_<名前>.sql` | D1 は Control Plane 専用（CLAUDE.md 不変条件） |
| 当てる先の解決 | `packages/data-api/wrangler.jsonc` の3環境の `CONTROL_DB` | `CONTROL_DB` を binding しているのは data-api だけで、`database_id` が `infra:sync` で書き戻されるのもそこだけ |

3環境の `CONTROL_DB` に `"migrations_dir": "../control-plane/migrations"` がある。パスは**設定ファイルのディレクトリ**から解決される。
control-plane に wrangler の設定ファイルを足さないこと。`infra:sync` の同期対象外なので `database_id` が仮の値のまま残る。

`packages/data-api/src/index.test.ts` が次を確かめる（`pnpm test` に含まれる）：

- 3環境とも `migrations_dir` が `packages/control-plane/migrations` を指し、`migrations_table` を変えていない
- ファイル名が `<4桁の連番>_<名前>.sql` で、0001 から欠番・重複なく並ぶ
- §2.1 の適用コマンドで env.dev に `--local` で全部当たり、2回目は何も当てない

**壊れた SQL は PR の段で落ちる。** ここで落とさないと、main へのマージ後に staging の CD（§3 ①）で初めて落ちる。
ただしデータに依存する失敗（既存の重複行に対する UNIQUE 索引など）は空の DB では再現しない。

> ⚠️ **手元の `pnpm test` / `pnpm check` は、SQL だけを変えたときに前回の合格を再生することがある。**
> turbo は data-api の test のキャッシュの鍵に control-plane のファイルを含めない（2026-09-14 実測：壊した SQL で `cache hit`）。
> SQL を足した・直したら **`pnpm --filter @musubi/data-api test`** で turbo を通さずに走らせる。
> CI（`lint-typecheck-unit`）は turbo のキャッシュを持ち越さないので毎回走る。

### 1.2 migration を書く

```bash
pnpm exec wrangler d1 migrations create CONTROL_DB <名前> --env dev --config packages/data-api/wrangler.jsonc
```

- 番号は wrangler が次の番号で振る。`<名前>` は英小文字・数字・`_` だけにする（テストが落とす）
- 3環境とも同じ `migrations_dir` を見るので、`--env` は `dev` でよい
- **1ファイル＝1つのまとまり。** wrangler はファイル単位で当て、失敗したファイルはそのファイルごと戻す（§2.3）。
  だから**どのファイルの境目で止まっても、1つ前のコードが動く形**に分ける
- 番号が他の PR と衝突したら、**マージする前に**後から出す側が番号を振り直す。
  wrangler はファイル名の順に当てるので、番号が前後すると環境によって当たる順が変わりうる

### 1.3 当てたファイルは直さない

適用済みの記録は各 DB の `d1_migrations` 表に**ファイル名で**残る（`name` は UNIQUE）。
中身を直しても、すでに当てた環境には二度と当たらない。**環境ごとにスキーマが食い違う。**

- 当てたファイルを編集・改名・削除しない。直すときは**新しい番号のファイルを足す**
- 例外は「**どの環境の `d1_migrations` にも載っていない**」ことを確かめたファイルだけ（§5.2）

---

## 2. 当てる

### 2.1 ローカル（`--local`）

```bash
pnpm exec wrangler d1 migrations list  CONTROL_DB --env dev --config packages/data-api/wrangler.jsonc --local
pnpm exec wrangler d1 migrations apply CONTROL_DB --env dev --config packages/data-api/wrangler.jsonc --local
```

**2026-09-14 実測（wrangler 4.131.1）**：`0001_musubi_meta.sql` が ✅ で当たり、2回目は `No migrations to apply!`。

- 永続化先は `packages/data-api/.wrangler/state/v3/d1/`（ignore 済み）。別の場所に置くときは `--persist-to <dir>`。
  `wrangler dev` と永続化先が食い違うときも `--persist-to` で揃える
- ローカルの DB は **`database_id` ごとに1つ**である（ID を変えると、同じ永続化先でも未適用に戻る。実測）。
  3環境とも `<TF_OUTPUT>` のままの間は、**dev / staging / production のローカル DB は同じ1つ**になる
  （dev に当てると staging の `list` も空になる。実測）
- `infra:sync` で実物の ID が書き戻されると、ローカルでは別の空の DB に切り替わる。もう一度 `apply --local` する
- ローカルを作り直すときは `packages/data-api/.wrangler/state/v3/d1/` を消してから `apply --local`

### 2.2 実物（`--remote`）

> ⚠️ **`--remote` への適用は、`infra:sync` で `database_id` が書き戻された後でないとできない。**
> `packages/data-api/wrangler.jsonc` の `database_id` が `<TF_OUTPUT>` のままでは、どの実物の D1 も指していない。
> 先に `pnpm infra:sync --env <env> --check` が通ることを確かめる（書き戻しは apply の直後に行いコミットする。`03` §3・`infra/terraform/README.md` §2）。

| env | 誰が当てるか |
|---|---|
| **staging** | **CD（`deploy-staging.yml`）だけ**。手で当てない（§3） |
| **production** | **CD（`deploy-production.yml`）だけ**。手で当てない（§3） |
| dev | CD が無いので手元から。`pnpm deploy:dev` と同じく **migration → deploy の順** |

dev の実物に当てる手順：

```bash
set -a; . "$(git rev-parse --show-toplevel)/.env"; set +a   # CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID（アカウント①）
pnpm infra:sync --env dev --check                           # database_id が実物と一致していること
pnpm exec wrangler d1 migrations list  CONTROL_DB --env dev --config packages/data-api/wrangler.jsonc --remote
pnpm exec wrangler d1 migrations apply CONTROL_DB --env dev --config packages/data-api/wrangler.jsonc --remote
pnpm deploy:dev
```

`infra:sync --check` は `infra/terraform/envs/dev` を `terraform init` 済みであることが前提
（backend の資格情報の渡し方は `infra/terraform/README.md` §2。Cloudflare のトークンは使わない。`03` §3）。

### 2.3 当てている間と、失敗したとき

- wrangler は確認で「**適用中は DB がリクエストに応えないことがある**」と出す。非対話（CD）では確認を飛ばして進む
- **失敗したファイルはそのファイルごと戻り、それより前のファイルは当たったまま残る。後ろのファイルは当てない。**
  終了コードは非0（wrangler 4.131.1 の `--help` の記述。ローカルでも実測）
- CD では ① が赤になり、② のデプロイは走らない。**動いているのは1つ前のコード**で、スキーマは「落ちたファイルの手前」まで進んでいる。
  §4 を守っていれば、この状態でそのまま動く

---

## 3. デプロイ順序：migration → deploy（CD と揃える）

`deploy-staging.yml`（`04` §4）の並び。`deploy-production.yml`（`04` §5）は `--env production` に読み替えた同じ並び。

| 段 | やること | この順である理由 |
|---|---|---|
| ⓪ | `pnpm infra:sync --env <env> --check` | **`--remote` は `database_id` が実物と一致していないと当たらない**（§2.2）。乖離があればここで止まる |
| | `pnpm build` | |
| ① | `pnpm exec wrangler d1 migrations apply CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc --remote` | 新しいコードは新しいスキーマを前提にしてよい。だから**スキーマが先** |
| ② | `wrangler deploy`：data-api → gateway → host | D1 を触るのは data-api だけ（CLAUDE.md 不変条件） |
| ③ | `pnpm smoke --env <env>` | |

**① と ② の間は、古い data-api が新しいスキーマの上で動いている。** ② が落ちても、コードを巻き戻しても（`04` §6.1。
`rollback.yml` は migration を**当てない**）、同じ状態になる。これを安全にするのが §4 の前方互換規律である。

逆向き（**新しいコードが古いスキーマで動く**）は、この順を守る限り起きない。起きるのは Time Travel でスキーマを戻したときだけで、
だから §5.3 では**コードを先に戻す**。

---

## 4. 前方互換規律

### 4.1 定義

> **migration を含むリリースを出すとき、1つ前のリリースの data-api が、その migration を当てた後のスキーマでそのまま動くこと。**

「1つ前のリリース」は、① と ② の間に動いているコードであり、**巻き戻し先**（`04` §6.1 の「直前の正常タグ」）でもある。
2つ以上前へ巻き戻すときは、その間に入った migration をこの目で見直してから戻す。

production のタグには main の複数のコミットが入り、migration も複数入りうる。**§4.2 で ✅ の変更は、§4.3 を守ったコードに対しては
いくつ重ねても壊さない**ので、1つのタグに何本入ってもよい。❌ の変更だけが §4.4 の段取りを要る。

### 4.2 SQL の側：単発で出してよい変更・いけない変更

| 変更 | 単発で | 条件・理由 |
|---|---|---|
| `CREATE TABLE` | ✅ | 古いコードは知らない表を使わないだけ |
| `CREATE INDEX`（UNIQUE でない） | ✅ | 読み書きの結果を変えない |
| `ALTER TABLE … ADD COLUMN` | ✅ | **NULL 可か、定数の `DEFAULT` 付き**。古いコードの INSERT がその列を書かなくても通るように。<br>`NOT NULL` だけの列は SQLite が拒否する。`DEFAULT (strftime(…))` のような式も ADD COLUMN では使えない（2026-09-14 実測・ローカル D1） |
| 行を足す（初期データの `INSERT`） | ✅ | 古いコードが知らない行を読んでも落ちないこと |
| `DROP TABLE` / `ALTER TABLE … DROP COLUMN` | ❌ | 古いコードが読み書きしている → §4.4 |
| `ALTER TABLE … RENAME` / `RENAME COLUMN` | ❌ | 古いコードの SQL が名前で落ちる → §4.4（改名ではなく「足す → 移す → 消す」） |
| `NOT NULL`・`UNIQUE`・`CHECK`・外部キーを足す | ❌ | **締める変更。** 古いコードの書き込みが制約で落ちる → §4.4 |
| 列の型を変える・表を作り直す | ❌ | SQLite に列の型変更は無く、表の作り直しになる。新しい表を足して移す → §4.4 |
| 既存の行の意味を変える `UPDATE` | ❌ | 古いコードが古い意味で読む → §4.4 |

- 表を作り直すときに外部キーに引っかかるなら、`PRAGMA defer_foreign_keys = true` で遅らせる（Cloudflare の D1 マイグレーションの文書）

### 4.3 コードの側：列が増えても落ちない書き方

前方互換は SQL だけでは成り立たない。**古いコードが、自分の知らない列・行・値に出会っても落ちない**書き方をしておく。

- **`INSERT` は列名を書く。** `INSERT INTO t VALUES (…)` は列が1つ増えた瞬間に落ちる（`table t has 3 columns but 2 values were supplied`。実測）
- **`SELECT *` を使わない。** 列名を書く。列が増えると行の形が変わる
- 行を検証するときに**知らない列を拒否しない**
- 状態を表す値（TEXT の列挙など）を足すときは、**先に「知らない値を読んでも落ちない」コードを1リリース出してから**書き始める

### 4.4 2段階リリース（広げる → 撤去する）

§4.2 で ❌ の変更は、**リリースを分けて**出す。各リリースを出す瞬間に §4.1 を満たすように並べる。

**例：`users.display_name`（NULL 可）を `users.nickname` に改名する**（例示。M0 にこの表は無い）

| リリース | migration | data-api のコード | 1つ前のリリースはこのスキーマで動くか |
|---|---|---|---|
| R1 広げる | `ALTER TABLE users ADD COLUMN nickname TEXT;` | 両方に書く。`nickname` を読み、NULL なら `display_name` | R0：列が増えただけ → 動く |
| R2 移す | `UPDATE users SET nickname = display_name WHERE nickname IS NULL;` | `nickname` だけを読み書きする | R1：`nickname` を読める → 動く |
| R3 撤去する | `ALTER TABLE users DROP COLUMN display_name;` | R2 と同じ | R2：`display_name` を使っていない → 動く |

- R1 と R2 を1つのリリースにすると、その ① と ② の間に R0 が `display_name` だけを書き、移し漏れが出る。
  移すのは、動いているコードが全部両方に書くようになってから
- R2 と R3 を1つのリリースにすると、その ① と ② の間に動くのは R1 で、R1 は `display_name` を読み書きする
- 列を消すだけなら「R1：コードが使わなくなる（migration なし）→ R2：`DROP COLUMN`」の2リリース

**守ること**

- **撤去する migration は、1つ前のリリースのコードが撤去対象を読みも書きもしていないときだけ出す**
- **各段は別々の production タグで出す。** staging は main へのマージごとに配るので段が分かれるが、
  production は1つのタグに入った変更を一度に配る。2段を1つのタグに入れると、① と ② の間に「撤去対象を使うコード」が動く
- **次の段の PR は、前の段が production に出てからマージする**（staging と production で同じ順に踏ませる）
- ❌ の変更を含む PR は、本文に「何段目か」と「1つ前の production リリースが撤去対象を使っていないこと」を書き、**人が承認する**。
  `04` §6.2 にある「destructive migration を CI が警告する」仕組みは**まだ無い**。それまではレビューだけが止める

---

## 5. 巻き戻し

wrangler の `d1 migrations` は `create` / `list` / `apply` の3つだけで、外す操作は無い（wrangler 4.131.1）。

| 状況 | やること |
|---|---|
| 新しいコードが悪い。スキーマは正しい | **コードだけ戻す**（§5.1）。migration は当てたまま |
| migration の中身が悪い。データは壊れていない | **前へ直す**（§5.2）。直す migration を新しい番号で足す |
| CD の ① が落ちた | §5.2。落ちたファイルはその env には当たっていない（§2.3） |
| データが壊れた／前方互換を破ってしまい、前へ直すのでは間に合わない | **Time Travel**（§5.3）。🧑 |

### 5.1 コードだけ戻す（ふつうはこれ）

`docs/runbook/rollback.md`（`04` §6.1）の手順で1つ前のリリースへ戻す。**migration には触らない。**
§4 を守っていれば、1つ前のコードは今のスキーマで動く。

### 5.2 前へ直す

1. 直す SQL を**新しい番号のファイル**で書く（§1.2）。§4.2 の表に照らす
2. 通常の PR → main → CD で当てる。production はタグで出す

**落ちたファイルを直してよいのは、どの環境の `d1_migrations` にも載っていないときだけ**（§1.3）。確かめ方：

```bash
pnpm exec wrangler d1 migrations list CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc --remote
# そのファイルが「未適用」として出れば、その env には当たっていない。dev / staging / production の全部で確かめる
```

1つでも当たっている環境があれば、ファイルは直さず新しい番号で足す。production の `--remote` は production の資格情報が要るので 🧑 が確かめる（§5.3 の渡し方）。

### 5.3 Time Travel（最後の手段・🧑・未実演）

D1 の Time Travel は、DB を**過去の時点へ丸ごと戻す**（スキーマもデータも）。

- 戻せる範囲：**Workers Free は 7日、Workers Paid は 30日**（Cloudflare の Time Travel の文書・2026-09-14 確認）。
  wrangler の `--help` は「30日以内」と書くが、Free では 7日しか戻れない
- **破壊的な操作である。** その場で上書きし、戻した時点より後の書き込みは失われる。実行中のクエリは打ち切られる
- 戻した直後に返る bookmark で、戻す前へやり直せる

手順（production は 🧑 が手元から。`.env` の `CLOUDFLARE_API_TOKEN_PROD` / `CLOUDFLARE_ACCOUNT_ID_PROD` を
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` として渡す）：

```bash
# 1. コードを先に戻す：戻す時点のスキーマで動くリリースへ（§5.1）。
#    新しいコードが古いスキーマで動くことは §4 では保証していない

# 2. 今の bookmark を控える（やり直し用）
pnpm exec wrangler d1 time-travel info CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc

# 3. 戻す時点の bookmark を得る。時点は CD の ① が始まる直前（GitHub Actions のログの時刻・UTC）
pnpm exec wrangler d1 time-travel info CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc \
  --timestamp <RFC3339。例 2026-09-14T01:23:45Z>

# 4. 戻す
pnpm exec wrangler d1 time-travel restore CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc \
  --bookmark <3 の bookmark>

# 5. 戻した migration が「未適用」に戻っていることを確かめる
pnpm exec wrangler d1 migrations list CONTROL_DB --env <env> --config packages/data-api/wrangler.jsonc --remote
```

> ⚠️ **戻すと `d1_migrations` も戻る。** 5 で未適用として出た migration は、**次の CD でもう一度当たる。**
> 直し方が決まるまで、main へのマージと production のタグを止める。
> そのファイルを直してよいかは §5.2 と同じ判定で決める（staging にだけ当たったまま、というのがよくある形。
> staging も同じ時点へ戻すか、ファイルは残して後ろに直す migration を足すかを、その事故ごとに決める）。

### 5.4 バックアップ（export）

```bash
pnpm exec wrangler d1 export musubi-<env>-control --remote --env <env> --config packages/data-api/wrangler.jsonc --output <file>.sql
```

- `export` の引数は `--help` で DB 名とされているので、binding ではなく `musubi-<env>-control` で指す
- 出力には `d1_migrations` の表も入る。取り込んだ先で適用済みの記録が揃う
- **中身は利用者のデータである。コミットしない。Actions の Artifact にもしない**（public リポジトリ。CLAUDE.md）
- M0 では手順だけ。定期実行して R2 へ置くのは M2（`04` §6.2）。まず Time Travel（§5.3）で足りる範囲かを考える
