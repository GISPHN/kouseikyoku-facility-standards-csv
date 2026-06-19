# 施設基準Excel CSV変換Webアプリ

厚生局が公開している「施設基準の届出受理状況」のExcelファイルを、データ分析しやすいロング形式CSVへ変換するブラウザ完結型Webアプリです。

対象ページ: [近畿厚生局 施設基準の届出受理状況](https://kouseikyoku.mhlw.go.jp/kinki/gyomu/gyomu/hoken_kikan/shitei_jokyo_00004.html)

## 使い方

GitHub Pagesで開き、`.xlsx` / `.xlsm` / `.xls` ファイルを選択するとCSVを作成します。処理はブラウザ内で完結し、Excelファイルをサーバーへ送信しません。

## 入力Excel

- ヘッダー行は「項番」「医療機関番号」「医療機関名称」を含む行から自動検出します。
- 近畿厚生局の2026年5月版では、ヘッダーは4行目、データは5行目から始まります。
- 1医療機関に複数の施設基準届出があるため、CSVは届出1件につき1行のロング形式です。

## 主な出力列

- `corporation_name`: 法人名
- `hospital_name`: 医療機関名
- `full_name`: Excel上の医療機関名称
- `bed_type`, `bed_count`: 病床区分と病床数を `;` 区切りで出力
- `bed_summary`: `一般:273;結核:37` のような病床サマリー
- `bed_total`: 病床数の合計
- `standard_name`: 受理届出名称
- `standard_code`: 受理記号
- `acceptance_no`: 受理番号
- `start_date_iso`: 算定開始年月日を西暦ISO形式に変換
- `start_year`, `start_month`, `start_day`: 算定開始年月日を西暦の年・月・日に分解
- `latitude`, `longitude`: 国土地理院住所検索APIから取得した緯度・経度

## ジオコーディング

同一医療機関は1回だけジオコーディングします。加算・届出が複数行あっても、同じ医療機関住所へ重複してAPIリクエストしません。

API間隔は国土地理院のサービス負荷を抑えるため、アプリ内部で500ms固定にしています。ユーザー側では変更できません。

## 注意

国土地理院住所検索APIは住所文字列に対する候補検索です。CSVには候補名を `geocode_title` に入れているため、必要に応じて確認してください。
