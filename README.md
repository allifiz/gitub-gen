# Gitub Gen

Generator KPI dari **DSM DOCX + timeline GitHub issue** tanpa OAuth, PAT, GitHub CLI, atau approval organization.

Extension ini berjalan di Chrome yang **sudah login GitHub kantor**. Ia membuka setiap issue dari DSM di background tab, membaca event timeline, mengambil timestamp exact dari elemen `relative-time[datetime]`, lalu menghasilkan Excel.

## Rule KPI

- **Start Time** = event pertama yang berubah **to In Progress**
- **End Time** = event pertama **to Ready to Review** setelah Start Time
- Event setelah Ready to Review pertama diabaikan.
- Timestamp GitHub (UTC) dikonversi ke **Asia/Jakarta / WIB**.
- Jika ticket muncul berkali-kali di DSM:
  - `Date` = kemunculan pertama
  - `Status` = status DSM terakhir
  - output tetap satu row per URL issue.

## Kenapa Chrome extension?

Private repo GO-Bimbel dibatasi untuk OAuth App. Extension tidak meminta akses organisasi baru. Ia membaca halaman GitHub yang memang sudah bisa dibuka oleh session Chrome user saat ini.

Tidak ada password atau token GitHub yang disimpan oleh Gitub Gen.

## Install

Clone repo:

```bash
git clone https://github.com/allifiz/gitub-gen.git
cd gitub-gen
npm install
npm run build
```

Lalu di Chrome:

1. Buka `chrome://extensions`
2. Aktifkan **Developer mode**
3. Klik **Load unpacked**
4. Pilih folder `dist` dari repo ini
5. Pin **Gitub Gen** kalau mau

Pastikan Chrome yang sama sudah bisa membuka private issue GO-Bimbel.

## Pakai

1. Klik icon extension **Gitub Gen**
2. Gitub Gen akan terbuka sebagai **tab permanen**, bukan popup
3. Assignee default: `Allief`
4. Pilih file `BASIC DAILY STANDUP ... .docx`
5. Halaman tetap terbuka ketika native file picker muncul
6. Extension menampilkan jumlah issue unik yang ditemukan
7. Klik **Generate KPI Excel**
8. Extension akan:
   - membuka issue GitHub satu per satu sebagai background tab
   - membaca timeline
   - menutup tab otomatis
   - mengunduh `KPI-<Bulan>-<Tahun>.xlsx`

Tidak perlu hover timestamp, DevTools, copy-paste tanggal, atau membuka issue satu per satu.

> UI sengaja dibuka sebagai tab extension biasa. Chrome menutup action popup ketika popup kehilangan fokus (misalnya saat file picker dibuka), jadi upload DOCX tidak diletakkan di popup.

## Format Excel

Sheet **KPI**:

| Assignee | Type | Ticket Title | Ticket URL | Type | Status | Priority | Date | Week | Start Time | End Time | Hour |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

Sheet **Diagnostics** menyimpan status scraping tiap URL:

- `OK`
- `NO_IN_PROGRESS`
- `NO_READY_TO_REVIEW`
- `NO_ACCESS`
- `ERROR`

Ini berguna kalau ada ticket yang workflow statusnya tidak lengkap.

## Contoh timeline yang didukung

```text
allifgobimbel
moved this from Todo to In Progress in BE-TASK
2026-09-18T03:08:03.000Z

...

allifgobimbel
moved this from In Progress to Ready to Review in BE-TASK
2026-09-18T04:12:54.000Z
```

Hasil WIB:

```text
Start Time: 2026-09-18 10:08:03
End Time:   18/09/2026 11:12:54
Hour:       1.0808333333
```

## Development

```bash
npm run build
```

Setelah rebuild, buka `chrome://extensions` lalu klik tombol reload pada Gitub Gen.

## Privacy

- Semua parsing DOCX dilakukan lokal di browser.
- Timeline dibaca dari tab GitHub milik browser user.
- Tidak ada backend.
- Tidak ada OAuth App.
- Tidak ada PAT.
- Tidak ada upload DSM ke server.
