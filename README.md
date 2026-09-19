# Gitub Gen

Generator KPI dari **DSM DOCX + GitHub timeline** tanpa OAuth, PAT, GitHub CLI, atau approval organization.

Extension berjalan di Chrome yang **sudah login GitHub kantor**.

## Model final

Aturan utama:

> **1 row KPI = 1 Ticket URL + 1 tanggal + 1 sesi DSM**

Artinya ticket yang sama boleh menghasilkan dua row di hari yang sama kalau muncul di DSM 11.00 dan DSM 16.00.

Contoh:

```text
#123 | 19-09-2026 | DSM 11.00
#123 | 19-09-2026 | DSM 16.00
```

DSM menentukan bahwa pekerjaan memang terjadi.

GitHub hanya dipakai untuk mencari bukti waktu:

- Start Time
- End Time
- Hour

Jam DSM **bukan cutoff keras**. Pekerjaan sesi 11 boleh selesai lewat 11, dan pekerjaan sesi 16 boleh lanjut lewat 16.

## Kenapa pakai activity cluster?

Contoh aktivitas satu ticket pada hari yang sama:

```text
09:08
09:45
10:30
11:18

13:12
14:20
15:50
17:06
```

Gitub Gen memecah activity berdasarkan jeda tidak aktif.

Default sekarang:

```text
inactivity gap >= 90 menit
=> cluster baru
```

Hasil:

```text
Cluster 1: 09:08 -> 11:18
Cluster 2: 13:12 -> 17:06
```

Kemudian cluster dipasangkan ke sesi DSM berdasarkan kedekatan waktunya.

Jadi:

```text
DSM 11 -> Cluster 1
DSM 16 -> Cluster 2
```

bukan berdasarkan potongan kaku 09-11 atau 13-16.

Kalau hanya ada satu cluster dan ticket muncul di dua sesi, cluster diberikan ke sesi DSM yang paling dekat. Sesi lain tetap masuk Excel tetapi waktunya kosong.

## Prioritas waktu

### 1. Status pair

Kalau work graph punya perpindahan dari In Progress sampai Ready to Review atau langsung Staging:

```text
to In Progress
...
to Ready to Review / to Staging
```

dan pasangan itu terjadi pada hari DSM, pasangan status dianggap bukti paling kuat.

Time Source:

- `ROOT_ISSUE_STATUS`
- `RELATED_ISSUE_STATUS`

Jika PR activity juga terjadi di rentang status tersebut, PR activity dianggap bagian cluster yang sama tetapi Start/End tetap memakai status pair exact.

### 2. Related activity

Kalau status ticket sudah Staging/Ready to Review dan PIC tidak mengubahnya kembali ke In Progress, DSM tetap membuktikan pekerjaan baru terjadi.

Gitub Gen mencari activity milik GitHub username yang diisi di UI pada linked PR dari:

- root issue
- sub-issue
- parent issue yang relevan
- PR gateway
- PR DB

Contoh:

```text
13:12 PR DB activity
14:03 PR gateway activity
15:44 PR activity
17:06 PR activity
```

Jika masih satu cluster:

```text
Start = 13:12
End   = 17:06
Time Source = RELATED_ACTIVITY
```

Walaupun DSM-nya jam 16.00 dan status issue tetap Staging.

### 3. Bukti kurang

Kalau cluster hanya punya satu activity:

```text
INSUFFICIENT_ACTIVITY
```

Kalau tidak ada activity yang cocok:

```text
DSM_ONLY
```

Pada dua kondisi itu:

- row KPI tetap dibuat
- Start Time kosong
- End Time kosong
- Hour kosong

Gitub Gen tidak menggunakan jam standup sebagai jam mulai/selesai dan tidak mengarang durasi.

## Work graph

URL dari DSM dianggap root / entry point.

Contoh:

```text
ROOT ISSUE
├── PR gateway
└── SUB-ISSUE DB
    └── PR DB
```

atau:

```text
ROOT ISSUE DB
├── PR DB
└── SUB-ISSUE gateway
    └── PR gateway
```

Jadi kalau perubahan hanya terjadi di sub-ticket DB atau hanya di gateway, activity masih bisa ditemukan.

Safeguard crawler:

- max depth: 2
- max graph nodes: 24
- saat naik ke parent issue, sibling sub-issue tidak ikut disapu

## Parser DSM

Parser mempertahankan sesi DSM.

Key internal sekarang:

```text
Ticket URL + Date + DSM Session
```

Jadi:

```text
#123 | 19-09-2026 | 11:00
#123 | 19-09-2026 | 16:00
```

adalah dua row berbeda.

Kalau ticket yang sama muncul dua kali di **sesi yang sama**, barulah digabung.

Parser juga mendukung variasi format lama dan baru:

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
3. Assignee default: `Allief`
4. GitHub username default: `allifgobimbel`
5. pilih DSM `.docx`
6. preview menampilkan tanggal + sesi DSM + status
7. klik **Generate KPI Excel**

Gitub Gen kemudian:

- parse DSM per sesi
- crawl work graph tiap root issue
- membaca exact `relative-time[datetime]`
- mengumpulkan activity pada tanggal DSM
- membentuk cluster dengan inactivity gap 90 menit
- memasangkan cluster ke DSM 11/16 berdasarkan kedekatan waktu
- memakai status pair bila tersedia
- fallback ke first/last related activity
- mengubah UTC ke WIB
- membuat Excel

## Excel

### KPI

Sheet **KPI** tetap bersumber dari DSM + GitHub timeline:

| Assignee | Type | Ticket Title | Ticket URL | Type | Status | Priority | Date | Week | Start Time | End Time | Hour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Sesi DSM tidak ditambahkan ke sheet KPI agar format lama tetap kompatibel. Jika ticket/date sama muncul dua kali, Start/End yang berbeda menunjukkan sesi masing-masing.

### Rekap Tiket Unik

Sheet **Rekap Tiket Unik** tidak menggunakan hasil parsing DSM sebagai daftar ticket.

Sumbernya langsung dari GitHub Project:

```text
https://github.com/orgs/GO-Bimbel/projects/11/views/1
```

Extension membuat filter otomatis dari bulan/tahun DSM dan GitHub username:

```text
year:2026 month:Agustus assignee:allifgobimbel
```

Lalu Project view dibuka memakai session Chrome yang sudah login. Karena GitHub Projects memakai virtualized rows, extension melakukan scroll dan mengumpulkan setiap issue yang muncul sampai bagian bawah stabil.

Ticket dideduplikasi berdasarkan URL issue GitHub.

Kolom sheet:

| Assignee | Type | Ticket Title | Ticket URL | Status | Priority | Date | Week |
| --- | --- | --- | --- | --- | --- | --- | --- |

Nilai Title, URL, Status, Priority, Date, dan Week dibaca dari row GitHub Project. Type diturunkan dari prefix judul seperti `[SUPERAPPS-SMBA]` menjadi `SUPERAPPS`.

Dengan model ini, jumlah ticket rekap tidak bergantung pada format DSM dan pasangan Ticket Title/Ticket URL berasal dari item Project yang sama.

### Diagnostics

Sheet **Diagnostics** menyimpan detail:

- Row Key
- Root Ticket
- Date
- DSM Session
- DSM Statuses
- Time Source
- Cluster #
- Cluster Start ISO
- Cluster End ISO
- Status Sources
- Activity Sources
- Activity Count
- Related Issues
- Related PRs
- Start ISO
- End ISO
- Graph Errors

Diagnostics adalah tempat mengecek kenapa suatu row dipasangkan ke cluster tertentu.

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
