# Gitub Gen

Generator KPI dari **DSM DOCX + work graph GitHub** tanpa OAuth, PAT, GitHub CLI, atau approval organization.

Extension berjalan di Chrome yang **sudah login GitHub kantor**. URL issue dari DSM diperlakukan sebagai **root ticket**, lalu Gitub Gen membuka timeline GitHub di background dan mengikuti hubungan kerja yang relevan:

- root issue
- sub-issue
- parent issue (jika root ternyata sub-ticket)
- linked pull request dari root/sub/parent yang relevan

Tujuannya supaya pekerjaan yang sebenarnya terjadi hanya di DB sub-ticket atau hanya di gateway/main ticket tetap terbaca.

## Model data: Work Episode

Gitub Gen **tidak lagi memakai aturan 1 issue = 1 row**.

Satu URL issue boleh menghasilkan beberapa row KPI kalau DSM menunjukkan ticket tersebut dikerjakan lagi.

Contoh:

```text
8 Sep   In Progress
9 Sep   Ready to Review
        => Episode 1

10 Sep  In Progress
11 Sep  Ready to Review
        => Episode 2

12 Sep  Staging + change request dikerjakan lagi
        => Episode 3
```

DSM pada tanggal yang sama (mis. 11.00 dan 16.00) digabung menjadi satu entri harian, tetapi seluruh status pada hari tersebut tetap disimpan.

## Penentuan waktu

Urutan sumber waktu:

### 1. Status issue dalam work graph

Gitub Gen mencari pasangan:

```text
to In Progress
...
to Ready to Review
```

bukan hanya di root issue, tetapi juga di related issue/sub-issue.

Kalau beberapa issue dalam work graph sama-sama punya pasangan status pada episode yang sama:

- Start = status In Progress paling awal
- End = Ready to Review paling akhir

Time Source:

- `ROOT_ISSUE_STATUS`
- `RELATED_ISSUE_STATUS`

### 2. Related PR activity

Kalau status tidak diubah tetapi DSM membuktikan ticket dikerjakan lagi, Gitub Gen melihat aktivitas pull request milik GitHub username yang diisi di UI.

Contoh:

```text
Root: go-superapp-api#100
├── PR gateway #700
└── Sub issue db-kbm#200
    └── PR DB #555
```

Jika pada tanggal DSM hanya PR DB yang aktif, sumber waktu bisa berasal dari PR DB. Jika gateway dan DB sama-sama aktif, aktivitas keduanya masuk activity pool.

Untuk mencegah durasi palsu karena malam/overnight, fallback PR activity otomatis hanya dihitung untuk **episode satu tanggal**.

Time Source:

- `RELATED_PR_ACTIVITY`
- `PR_ACTIVITY_PARTIAL`

### 3. DSM only

Kalau DSM mencatat pekerjaan tetapi GitHub tidak memiliki status pair atau aktivitas PR yang cukup:

- row KPI tetap dibuat
- Start Time kosong
- End Time kosong
- Hour kosong
- Diagnostics = `DSM_ONLY`

Gitub Gen tidak mengarang durasi dari jam standup.

## Work graph

Contoh struktur yang didukung:

```text
ROOT ISSUE
│
├── linked PR gateway
│
└── SUB-ISSUE DB
    └── linked PR DB
```

atau kebalikannya:

```text
ROOT ISSUE DB
│
├── linked PR DB
│
└── SUB-ISSUE gateway
    └── linked PR gateway
```

Jika root ternyata sebuah sub-ticket dan memiliki parent, parent boleh menyumbang linked PR. Namun crawler tidak menyapu seluruh sibling sub-ticket milik parent agar satu KPI tidak menarik pekerjaan yang tidak terkait.

Batas crawler:

- max depth: 2
- max graph nodes: 24

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

- membangun work episode
- membuka root issue otomatis
- menemukan sub-issue / parent / linked PR
- membaca exact `relative-time[datetime]`
- mencocokkan aktivitas dengan tanggal episode DSM
- mengubah UTC ke WIB
- membuat Excel

Tidak perlu hover timestamp, DevTools, atau membuka issue satu per satu.

## Excel

Sheet **KPI**:

| Assignee | Type | Ticket Title | Ticket URL | Type | Status | Priority | Date | Week | Start Time | End Time | Hour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Ticket URL tetap root URL dari DSM walaupun waktu pengerjaan ditemukan dari sub-issue atau PR repo lain.

Sheet **Diagnostics** mencatat per episode:

- Episode ID
- Root Ticket
- DSM Dates
- DSM Statuses
- DSM Times
- Time Source
- Status Sources
- Activity Sources
- Related Issues
- Related PRs
- Start ISO
- End ISO
- Graph Errors

Ini penting untuk audit kenapa suatu row mendapatkan jam dari root issue, sub-issue, PR DB, PR gateway, atau hanya DSM.

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

dan format Agustus yang URL issue-nya ditulis langsung tanpa label `GitHub :`:

```text
Task 1 | [GOEXPERT] ENHANCE: ...
https://github.com/.../issues/123
Status : ...
```

Kolom `Week` dihitung per blok 7 hari dari tanggal DSM pertama pada dokumen, bukan dari nomor tanggal kalender. Ini mengikuti pola rekap bulanan: bila DSM pertama bulan tersebut tanggal 3, maka tanggal 3-9 adalah Minggu 1, 10-16 Minggu 2, dan seterusnya.
