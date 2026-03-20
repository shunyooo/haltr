# 調査タスク パターン

## 概要
新しい情報が出てこなくなるまで繰り返し調査するパターン。
worker が毎回の調査結果を連番ファイルに記録し、verifier が前回との差分で新規情報の有無を判定する。

## task.yaml の例

```yaml
steps:
  - id: investigate-stripe
    instructions: |
      Stripe API の料金体系を調査する。

      調査結果は haltr/epics/<epic>/research-NNN.md に連番で記録する。
      - research-001.md, research-002.md, ... の形式
      - 1回の調査で1ファイル作成。既存ファイルは編集しない
      - 各ファイルには発見した情報を箇条書きで記載
      - 調査ソース（URL、ドキュメント名等）を明記

      1回目の調査が完了したら work_done を記録する。
      オーケストレーターから続行指示があれば次の調査を行う。
    accept: "最新の research-NNN.md に、1つ前の research-(N-1).md にない新しい情報が含まれていないこと"
    worker_session: shared
```

## オーケストレーターの動き

```
1. hal spawn worker (調査開始)
2. worker: research-001.md 作成 → work_done
3. orchestrator: hal spawn verifier (1回目は必ず FAIL = 新しい情報あり)
4. verifier: FAIL (新しい情報あり)
5. orchestrator: hal send → worker に「続行してください」
6. worker: research-002.md 作成 → work_done
7. orchestrator: hal spawn verifier
8. verifier: 002 と 001 を比較
   - 新しい情報あり → FAIL → 5 に戻る
   - 新しい情報なし → PASS → 完了
```

## verifier の判定基準
- 最新のファイルと1つ前のファイルを読む
- 最新ファイルの各項目が、前のファイルに既に含まれている情報の言い換えか、本当に新しい発見かを判定
- 新しい発見が1つもなければ PASS（調査完了）

## 注意点
- 1回目の verifier は常に FAIL にすること（比較対象がないため、または初回は必ず新しい情報がある）
- worker_session: shared を使うことで、worker のコンテキストが保持され効率的
- 調査ファイルが人間にも読める形式（Markdown）で残る
