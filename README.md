# 施設基準PDF CSV変換Webアプリ

厚生局が公開している「施設基準の届出受理状況」のPDFを、ブラウザだけで分析用CSVに変換する静的Webアプリです。サーバー、Node.js、Python、ローカル環境構築は不要です。

対象ページ: [近畿厚生局 施設基準の届出受理状況](https://kouseikyoku.mhlw.go.jp/kinki/gyomu/gyomu/hoken_kikan/shitei_jokyo_00004.html)

## 使い方

GitHub Pagesで公開したURLをブラウザで開き、PDFを選択してCSVを作成します。

想定URL:

```text
https://gisphn.github.io/kouseikyoku-facility-standards-csv/
```

GitHub Pagesを有効化していない場合は、リポジトリの `Settings > Pages` で `Deploy from a branch`、`main`、`/(root)` を選択してください。

## 仕組み

- PDFの読み取りはブラウザ内の PDF.js で実行します。
- CSV生成もブラウザ内で完結します。
- ジオコーディングを有効にした場合のみ、住所文字列を国土地理院の住所検索APIへ問い合わせます。
- PDFファイル自体は外部サーバーへアップロードしません。

## CSVの形式

1医療機関に複数の施設基準届出があるため、CSVは「1届出1行」のロング形式です。主な列は次の通りです。

- `corporation_name`: 法人名
- `hospital_name`: 医療機関名
- `full_name`: PDF上の名称
- `address`: 住所
- `standard_code`: 施設基準コード
- `acceptance_no`: 受理番号
- `start_date_jp`: 算定開始日
- `start_date_iso`: 算定開始日のISO形式
- `latitude`, `longitude`: 国土地理院APIから取得した緯度・経度

## 注意

- 国土地理院APIは住所文字列に対する候補検索です。CSVには候補名を `geocode_title` に入れているため、必要に応じて確認してください。
- 大きなPDFを全件ジオコーディングすると数分以上かかります。
- PDFのレイアウトが地方厚生局や公開月によって変わる場合は、`app.js` の抽出ルールを調整してください。
