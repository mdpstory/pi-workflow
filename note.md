# CLR ("Ask User") Feature Review

## Ringkasan

Fitur CLR (Clarification Request) memungkinkan setiap peran workflow mengajukan pertanyaan klarifikasi saat menemui ketidakjelasan. Sistem langsung menghentikan kerja agen dan memblokir semua tulisan sampai Director menyelesaikannya.

## Alur Kerja

```
Agen nemu kebingungan
  → wf_clr_open({ stage, question })
  → STOP (kerja berhenti)
  → Semua tulisan/file diboikot sampai CLR diselesaikan
  → Director baca clarifications.md, putuskan jawabannya
  → wf_clr_resolve({ id, resolution })
  → Boikot dicabut, kerja lanjut
```

## Keputusan Desain yang Bagus

1. **Blokir paksa, bukan cuma saran** — CLR memblokir tulisan lewat hook `tool_call`, bukan cuma aturan di skill. Agen benar-benar tidak bisa nulis.

2. **Blokir lintas tahap** — CLR di tahap `planning` juga memblokir tahap `research`. Tidak bisa lanjut kalau dasar masih ambigu.

3. **Hanya Director yang bisa resolve** — `requireDirector()` mencegah agen resolve CLR sendiri.

4. **Jejak audit** — Semua CLR dicatat di `clarifications.md` (status, pertanyaan, jawaban).

5. **Perbaikan status "blocked" (C6)** — Setelah CLR diresolve, status stage dikembalikan ke "in-progress".

6. **Dikecualikan dari batas tool** — `wf_clr_open` boleh dipakai meskipun agen sudah 55+ panggilan tool.

7. **Tidak blokir stage yang sudah selesai** — CLR terhadap stage "done" tidak mengubah statusnya.

## Masalah yang Ditemukan

### 1. ID Bisa Sama (Collision)

**Lokasi:** `tools/clr.ts`

```ts
const id = `CLR-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}`;
```

ID dibuat dari timestamp. Kalau dua CLR diajukan di detik yang sama, ID-nya identik. Peluang kecil tapi nyata dengan engineer paralel.

**Perbaikan:** Tambah suffix random:
```ts
const id = `CLR-${timestamp}-${Math.random().toString(36).slice(2,6)}`;
```

### 2. Tidak Ada Expired / Stale CLR Cleanup

CLR yang terbuka hidup selamanya di `clr-index.json`. Kalau agen crash setelah ajukan CLR, workflow **terblokir permanen** sampai Director sadar dan resolve manual.

**Saran:** 
- TTL check di `clrBlocksStage` (skip CLRs lebih dari N jam)
- Atau tool `wf_expire_clr`
- Atau tambahkan langkah di skill Director: "cek CLR stale saat resume"

### 3. Pertanyaan Bisa Kosong

Parameter `question` tidak ada validasi minimal (`Type.String()` tanpa `minLength`). Agen bisa isi `""` dan memblokir semua kerja tanpa pertanyaan jelas.

**Perbaikan:** `Type.String({ minLength: 1 })` atau enforce di skill docs.

### 4. `clarifications.md` Terus Bertambah

Setiap CLR + resolusi di-append. Untuk proyek panjang, file ini membesar terus. Dampak kecil per-entry tapi累积 (akumulasi) seiring waktu.

### 5. Tidak Ada Tool untuk List CLR

`wf_status` tampilkan ID CLR tapi bukan pertanyaannya. Harus baca `clarifications.md` manual. Tool `wf_clr_list` akan lebih efisien — return `{ id, stage, question, raisedBy }[]`.

### 6. Race Condition (Edge Case)

```ts
const clr = loadClr();      // baca
clr.open.push(entry);        // ubah
writeJson(clrIndexPath(), clr); // tulis
```

Operasi ini bukan atomik. Dua engineer paralel yang sama-sama ajukan CLR bisa kehilangan satu entri. Peluang kecil karena engineer jarang file CLR.

## Kesimpulan

Fitur ini **solid**. Desain blokir paksa adalah keputusan yang tepat — lebih baik hentikan daripada agen nebak.

**Prioritas perbaikan:**
1. Fix ID collision (mudah, tinggal tambah suffix random)
2. Tambah expired/stale CLR cleanup (cegah workflow terblokir permanen)
