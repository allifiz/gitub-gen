# Gitub Gen

Generator KPI dari **DSM DOCX + GitHub timeline** tanpa OAuth, PAT, GitHub CLI, atau approval organization.

Extension berjalan di Chrome yang **sudah login GitHub kantor**.

## Model yang dipakai

Aturan utama sekarang sengaja dibuat sederhana:

> **1 row KPI = 1 Ticket URL + 1 tanggal pengerjaan di DSM**

DSM menentukan row apa saja yang harus masuk ke KPI.

GitHub hanya dipakai untuk mencoba mengisi:

- Start Time
- End Time
- Hour

Jadi Gitub Gen tidak lagi mencoba menebak episode kerja lintas hari.

Jika ticket yang sama muncul lagi di tanggal berbeda, row baru tetap dibuat.

Contoh:

```text
21 Aug  #3697
24 Aug  #3697
```

menjadi dua row KPI.

Jika ticket yang sama muncul pada DSM 11.00 dan 16.00 di tanggal yang sama, parser menggabungkannya menjadi satu row harian dan menyimpan semua status/jam DSM untuk Diagnostics.

## Penentuan Start Time dan End Time

Urutannya hanya tiga langkah.

### 1. Status pair pada tanggal DSM

Gitub Gen mencari pasangan:

```text
to In Progress
...
to Ready to Review
```

dalam work graph ticket.

Work graph tetap boleh berisi:

- root issue dari DSM
- sub-issue
- parent issue jika root ternyata sub-ticket
- linked pull request dari issue terkait

Status pair hanya dipakai jika **Start dan End sama-sama terjadi pada tanggal DSM row tersebut**.

Jika beberapa related issue punya status pair pada tanggal yang sama:

- Start = In Progress paling awal
- End = Ready to Review paling akhir

Time Source:

- `ROOT_ISSUE_STATUS`
- `RELATED_ISSUE_STATUS`

### 2. Related activity pada tanggal DSM

Kalau tidak ada status pair yang valid, Gitub Gen mencari aktivitas milik GitHub username yang diisi di UI pada **linked PR di work graph** dan hanya pada tanggal DSM tersebut.

Contoh:

```text
Root issue
├── PR gateway
└── Sub-issue DB
    └── PR DB
```

Kalau hanya PR DB yang aktif hari itu, PR DB dipakai.

Kalau PR gateway dan PR DB sama-sama aktif, activity pool menggabungkan keduanya.

Jika ada minimal 2 timestamp:

```text
09:43 activity
10:12 activity
11:07 activity
```

maka:

```text
Start = 09:43
End   = 11:07
```

Time Source:

```text
RELATED_ACTIVITY
```

### 3. Bukti waktu tidak cukup

Kalau hanya ada satu related activity:

```text
INSUFFICIENT_ACTIVITY
```

Kalau tidak ada:

```text
DSM_ONLY
```

Untuk dua kondisi tersebut:

- row KPI tetap dibuat
- Start Time kosong
- End Time kosong
- Hour kosong

Gitub Gen tidak menggunakan jam standup sebagai jam kerja dan tidak mengarang durasi.

## Kenapa tetap ada work graph?

URL di DSM hanya dianggap sebagai **root / entry point**.

Pekerjaan sebenarnya bisa terjadi:

```text
ROOT ISSUE
├── PR gateway
└── SUB-ISSUE DB
    └── PR DB
```

atau kebalikannya.

Jadi crawler tetap mencari related issue dan PR agar perubahan yang hanya terjadi di DB atau hanya di gateway tetap bisa ditemukan.

Namun graph hanya membantu **mencari bukti pada tanggal DSM**. Graph tidak lagi dipakai untuk menyusun episode kerja lintas hari.

Safeguard:

- max depth: 2
- max graph nodes: 24
- saat naik ke parent issue, sibling sub-issue tidak ikut disapu

## Install

```bash
git clone https://github.com/allifiz/gitub-gen.git
cd gitub-gen
npm install
npm run build
```

Lalu:

1. buka `chrome://extensions`
2. aktifkan **Developer mode**
3. klik **Load unpacked**
4. pilih folder `dist`
5. pin **Gitub Gen**

Pastikan Chrome yang sama sudah bisa membuka private issue GO-Bimbel.

## Pakai

1. klik icon **Gitub Gen**
2. app terbuka sebagai tab permanen
3. isi Assignee, default `Allief`
4. isi GitHub username, default `allifgobimbel`
5. pilih DSM `.docx`
6. preview menampilkan jumlah entri DSM harian
7. klik **Generate KPI Excel**

Gitub Gen kemudian:

- parse DSM
- membuat 1 row per Ticket + Date
- crawl work graph tiap root issue
- membaca exact `relative-time[datetime]`
- mencari status pair pada tanggal row
- jika tidak ada, mencari related PR activity pada tanggal row
- mengubah UTC ke WIB
- membuat Excel

## Excel

Sheet **KPI**:

| Assignee | Type | Ticket Title | Ticket URL | Type | Status | Priority | Date | Week | Start Time | End Time | Hour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Sheet **Diagnostics** mencatat:

- Row Key
- Root Ticket
- Date
- DSM Statuses
- DSM Times
- Time Source
- Status Sources
- Activity Sources
- Activity Count
- Related Issues
- Related PRs
- Start ISO
- End ISO
- Graph Errors

Dengan ini kita bisa audit kenapa row tertentu mendapat jam atau dibiarkan kosong.

## DSM format compatibility

Parser mendukung variasi format DSM lama dan baru, termasuk:

```text
Task 1 | [SUPERAPPS-SMBA] FEAT: ...
GitHub : https://github.com/.../issues/123
```

```text
[SUPERAPPS-SMBA] FEAT: ...
GitHub : https://github.com/.../issues/123
```

dan URL issue polos tanpa prefix `GitHub :`.

Kolom `Week` dihitung per blok 7 hari dari tanggal DSM pertama pada dokumen.

## Development

```bash
npm run build
```

Setelah rebuild, buka `chrome://extensions` lalu klik **Reload** pada Gitub Gen.

## Privacy

- parsing DOCX dilakukan lokal di browser
- GitHub dibaca dari session Chrome yang memang sudah login
- tidak ada backend
- tidak ada OAuth App
- tidak ada PAT
- tidak ada upload DSM ke server
