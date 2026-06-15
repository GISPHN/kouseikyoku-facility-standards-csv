# 施設基準PDF CSV変換Webアプリ

厚生局が公開している「施設基準の届出受理状況」のPDFを、分析しやすいロング形式CSVに変換するWebアプリです。法人名と病院名を別列にし、住所を国土地理院の住所検索APIでジオコーディングして緯度・経度を付与できます。

対象ページ: [近畿厚生局 施設基準の届出受理状況](https://kouseikyoku.mhlw.go.jp/kinki/gyomu/gyomu/hoken_kikan/shitei_jokyo_00004.html)

## セットアップ

```bash
python -m pip install -r requirements.txt
npm start
```

ブラウザで `http://localhost:3000` を開き、PDFをアップロードします。

Pythonの実行ファイル名が `python` ではない環境では、環境変数で指定します。

```bash
PYTHON_BIN=python3 npm start
```

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
- 大きなPDFを全件ジオコーディングすると数分以上かかります。待ち時間を調整する場合は `GEOCODE_DELAY_MS` を変更してください。
- PDFのレイアウトが地方厚生局や公開月によって変わる場合は、`scripts/parse_pdf.py` の正規表現を調整してください。
