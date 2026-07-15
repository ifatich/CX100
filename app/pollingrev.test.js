'use strict';

const { chromium } = require('@playwright/test');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const {
  tungguOtpTerbaru,
  pindahkanOtpKeTrash,
} = require('./otp_gmail_helper');

// ==========================================================
// KONFIGURASI TEST
// ==========================================================

const TARGET_URL = 'https://danantaraindonesiacx100.com/polls/cx100-danantara';
const OTP_SENDER = 'noreply@danantaraindonesiacx100.com';
const OTP_SUBJECT = 'Kode Verifikasi - CX100 Danantara Indonesia';

// Script ini dibatasi satu data per eksekusi untuk pengujian alur end-to-end.
const TEST_LIMIT = 999;

const CHROME_DEBUG_PORT = 9222;
const CHROME_PROFILE_DIR = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'ChromeDebugCX100'
);

// Toleransi untuk proses validasi/verifikasi email yang kadang lebih lambat.
const EMAIL_VERIFICATION_TIMEOUT_MS = 120000;
const EMAIL_VERIFICATION_POLL_MS = 500;
const EMAIL_VERIFICATION_STATUS_INTERVAL_MS = 5000;
const PAGE_ACTION_TIMEOUT_MS = 30000;

// ==========================================================
// FUNGSI BANTUAN
// ==========================================================

function tanya(pertanyaan) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(pertanyaan, (jawaban) => {
      rl.close();
      resolve(jawaban.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function temukanChrome() {
  const kandidat = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(
      os.homedir(),
      'Applications',
      'Google Chrome.app',
      'Contents',
      'MacOS',
      'Google Chrome'
    ),
  ];

  return kandidat.find((lokasi) => lokasi && fs.existsSync(lokasi)) || null;
}

async function tungguChromeDebug(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const endpoint = `http://127.0.0.1:${CHROME_DEBUG_PORT}/json/version`;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return;
    } catch (_) {
      // Chrome mungkin masih dalam proses membuka remote debugging.
    }

    await sleep(500);
  }

  throw new Error(
    `Chrome remote debugging tidak aktif pada port ${CHROME_DEBUG_PORT}.`
  );
}

async function jalankanChrome() {
  // Jangan membuka proses baru jika Chrome debugging sudah aktif.
  try {
    await tungguChromeDebug(1000);
    console.log('\n=== Chrome Remote Debugging sudah aktif ===');
    return;
  } catch (_) {
    // Lanjut membuka Chrome.
  }

  const chromePath = temukanChrome();
  if (!chromePath) {
    throw new Error('Google Chrome tidak ditemukan di folder Applications macOS.');
  }

  console.log('\n=== Membuka Google Chrome Remote Debugging... ===');

  const child = spawn(
    chromePath,
    [
      `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
    ],
    {
      detached: true,
      stdio: 'ignore',
    }
  );

  child.unref();
  await tungguChromeDebug(15000);
}

function ambilWaktu() {
  const sekarang = new Date();
  return [
    sekarang.getHours(),
    sekarang.getMinutes(),
    sekarang.getSeconds(),
  ]
    .map((nilai) => String(nilai).padStart(2, '0'))
    .join(':');
}

function ambilTimestampFile() {
  const sekarang = new Date();

  const tanggal = [
    sekarang.getFullYear(),
    String(sekarang.getMonth() + 1).padStart(2, '0'),
    String(sekarang.getDate()).padStart(2, '0'),
  ].join('-');

  const waktu = [
    String(sekarang.getHours()).padStart(2, '0'),
    String(sekarang.getMinutes()).padStart(2, '0'),
    String(sekarang.getSeconds()).padStart(2, '0'),
  ].join('-');

  return `${tanggal}_${waktu}`;
}

function dapatkanFileHistoryHariIni() {
  const sekarang = new Date();
  const tanggal = [
    sekarang.getFullYear(),
    String(sekarang.getMonth() + 1).padStart(2, '0'),
    String(sekarang.getDate()).padStart(2, '0'),
  ].join('-');

  return `history_sukses_${tanggal}.txt`;
}

function bacaDaftarEmail(fileListEmail) {
  return [
    ...new Set(
      fs
        .readFileSync(fileListEmail, 'utf8')
        .split(/\r?\n/)
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function sanitasiNamaFile(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}


function siapkanFolderCapture(inputFolder) {
  const nilaiInput = String(inputFolder || '').trim();

  // Bila dikosongkan, gunakan folder "capture" di lokasi script dijalankan.
  const folderCapture = path.resolve(
    nilaiInput || path.join(process.cwd(), 'capture')
  );

  try {
    fs.mkdirSync(folderCapture, {
      recursive: true,
    });
  } catch (error) {
    throw new Error(
      `Folder capture tidak dapat dibuat/diakses: ${folderCapture}. ` +
      `Detail: ${error.message}`
    );
  }

  try {
    fs.accessSync(
      folderCapture,
      fs.constants.R_OK | fs.constants.W_OK
    );
  } catch (error) {
    throw new Error(
      `Folder capture tidak memiliki akses baca/tulis: ${folderCapture}. ` +
      `Detail: ${error.message}`
    );
  }

  return folderCapture;
}



/**
 * Mengisi alamat email dan menunggu proses validasi/verifikasi halaman depan.
 *
 * Halaman dapat melakukan pengecekan asynchronous setelah email ditempel.
 * Fungsi ini tidak memakai delay tetap, tetapi menunggu sampai kontrol
 * persetujuan benar-benar tersedia dan tombol Selanjutnya aktif.
 */
async function isiEmailDanTungguVerifikasi({
  pagePolling,
  emailSaatIni,
  cetakStatusLive,
  timeoutMs = EMAIL_VERIFICATION_TIMEOUT_MS,
}) {
  const emailInput = pagePolling.locator('input[type="email"]').first();

  await emailInput.waitFor({
    state: 'visible',
    timeout: PAGE_ACTION_TIMEOUT_MS,
  });

  // Bersihkan lalu isi ulang agar event input/change selalu terpanggil.
  await emailInput.click({ force: true });
  await emailInput.fill('');
  await emailInput.fill(emailSaatIni);

  // Trigger tambahan untuk halaman yang mulai memvalidasi setelah blur.
  await emailInput.dispatchEvent('input').catch(() => {});
  await emailInput.dispatchEvent('change').catch(() => {});
  await emailInput.press('Tab').catch(() => {});

  const labelPersetujuan = pagePolling
    .getByText(
      'Saya menyetujui pengiriman email verifikasi terkait polling yang akan dilakukan.',
      { exact: true }
    )
    .first();

  const checkboxPersetujuan = pagePolling
    .locator('input[type="checkbox"]:visible, [role="checkbox"]:visible')
    .first();

  const tombolSelanjutnya = pagePolling
    .locator('button:has-text("Selanjutnya"):visible, button[type="submit"]:visible')
    .first();

  const indikatorLoading = pagePolling
    .locator(
      [
        '[aria-busy="true"]:visible',
        '[role="progressbar"]:visible',
        '[class*="loading" i]:visible',
        '[class*="spinner" i]:visible',
        'text=/memverifikasi|verifikasi email|mohon tunggu|processing|loading/i',
      ].join(', ')
    )
    .first();

  const pesanErrorEmail = pagePolling
    .locator(
      [
        'text=/email.*(tidak valid|invalid|gagal|tidak ditemukan|tidak terdaftar)/i',
        'text=/(tidak valid|invalid).*email/i',
      ].join(', ')
    )
    .first();

  const deadline = Date.now() + timeoutMs;
  let waktuLogBerikutnya = Date.now() + EMAIL_VERIFICATION_STATUS_INTERVAL_MS;

  while (Date.now() < deadline) {
    const nilaiEmail = (await emailInput.inputValue().catch(() => '')).trim();

    if (nilaiEmail.toLowerCase() !== emailSaatIni.trim().toLowerCase()) {
      await emailInput.fill(emailSaatIni);
      await emailInput.dispatchEvent('input').catch(() => {});
      await emailInput.dispatchEvent('change').catch(() => {});
      await emailInput.press('Tab').catch(() => {});
    }

    if (await locatorTerlihat(pesanErrorEmail)) {
      const pesan = await pesanErrorEmail
        .innerText()
        .catch(() => 'Email ditolak oleh halaman.');

      throw new Error(`Verifikasi email gagal: ${pesan}`);
    }

    const labelTerlihat = await locatorTerlihat(labelPersetujuan);
    const checkboxTerlihat = await locatorTerlihat(checkboxPersetujuan);
    const tombolTerlihat = await locatorTerlihat(tombolSelanjutnya);
    const sedangLoading = await locatorTerlihat(indikatorLoading);

    // Kontrol persetujuan menjadi indikator utama bahwa validasi awal selesai.
    if ((labelTerlihat || checkboxTerlihat || tombolTerlihat) && !sedangLoading) {
      return {
        emailInput,
        labelPersetujuan,
        checkboxPersetujuan,
        tombolSelanjutnya,
      };
    }

    if (Date.now() >= waktuLogBerikutnya) {
      const sisaDetik = Math.max(
        0,
        Math.ceil((deadline - Date.now()) / 1000)
      );

      cetakStatusLive(
        `[Menunggu verifikasi email selesai... sisa toleransi ${sisaDetik} detik]`
      );

      waktuLogBerikutnya =
        Date.now() + EMAIL_VERIFICATION_STATUS_INTERVAL_MS;
    }

    await pagePolling.waitForTimeout(EMAIL_VERIFICATION_POLL_MS);
  }

  throw new Error(
    `Proses verifikasi email belum selesai setelah ${Math.round(
      timeoutMs / 1000
    )} detik.`
  );
}

/**
 * Memilih persetujuan halaman depan lalu menunggu tombol Selanjutnya aktif.
 * Tombol tidak diklik selama masih disabled atau halaman masih loading.
 */
async function setujuiDanKlikLanjutDepan({
  pagePolling,
  emailSaatIni,
  cetakStatusLive,
}) {
  cetakStatusLive('[Menempelkan Email dan menunggu verifikasi...]');

  const {
    labelPersetujuan,
    checkboxPersetujuan,
    tombolSelanjutnya,
  } = await isiEmailDanTungguVerifikasi({
    pagePolling,
    emailSaatIni,
    cetakStatusLive,
  });

  cetakStatusLive('[Menyetujui Form Depan...]');

  let persetujuanTerpilih = false;

  if (await locatorTerlihat(checkboxPersetujuan)) {
    try {
      const tagName = await checkboxPersetujuan.evaluate(
        (elemen) => elemen.tagName.toLowerCase()
      );

      if (tagName === 'input') {
        if (!(await checkboxPersetujuan.isChecked())) {
          try {
            await checkboxPersetujuan.check({
              timeout: PAGE_ACTION_TIMEOUT_MS,
            });
          } catch (_) {
            await checkboxPersetujuan.check({
              force: true,
              timeout: PAGE_ACTION_TIMEOUT_MS,
            });
          }
        }

        persetujuanTerpilih = await checkboxPersetujuan.isChecked();
      } else {
        const kondisiAwal =
          await checkboxPersetujuan.getAttribute('aria-checked');

        if (kondisiAwal !== 'true') {
          await checkboxPersetujuan.click({ force: true });
        }

        const kondisiAkhir =
          await checkboxPersetujuan.getAttribute('aria-checked');

        persetujuanTerpilih =
          kondisiAkhir === 'true' || kondisiAkhir === null;
      }
    } catch (_) {
      // Lanjut menggunakan label.
    }
  }

  if (!persetujuanTerpilih && await locatorTerlihat(labelPersetujuan)) {
    await labelPersetujuan.scrollIntoViewIfNeeded();

    try {
      await labelPersetujuan.click({
        timeout: PAGE_ACTION_TIMEOUT_MS,
      });
    } catch (_) {
      await labelPersetujuan.click({
        force: true,
        timeout: PAGE_ACTION_TIMEOUT_MS,
      });
    }

    // Pastikan checkbox benar-benar terpilih jika tersedia.
    if (await locatorTerlihat(checkboxPersetujuan)) {
      try {
        const tagName = await checkboxPersetujuan.evaluate(
          (elemen) => elemen.tagName.toLowerCase()
        );

        if (tagName === 'input' && !(await checkboxPersetujuan.isChecked())) {
          await checkboxPersetujuan.check({ force: true });
        }
      } catch (_) {
        // Beberapa halaman hanya menggunakan label custom.
      }
    }

    persetujuanTerpilih = true;
  }

  if (!persetujuanTerpilih) {
    throw new Error(
      'Kontrol persetujuan halaman depan tidak dapat dipilih.'
    );
  }

  cetakStatusLive(
    '[Menunggu tombol Selanjutnya aktif setelah verifikasi email...]'
  );

  const deadline = Date.now() + EMAIL_VERIFICATION_TIMEOUT_MS;
  let waktuLogBerikutnya =
    Date.now() + EMAIL_VERIFICATION_STATUS_INTERVAL_MS;

  while (Date.now() < deadline) {
    if (await locatorTerlihat(tombolSelanjutnya)) {
      const disabledNative = await tombolSelanjutnya
        .isDisabled()
        .catch(() => false);

      const ariaDisabled = await tombolSelanjutnya
        .getAttribute('aria-disabled')
        .catch(() => null);

      if (!disabledNative && ariaDisabled !== 'true') {
        cetakStatusLive('[Klik Lanjut Depan...]');

        await tombolSelanjutnya.scrollIntoViewIfNeeded();

        try {
          await tombolSelanjutnya.click({
            timeout: PAGE_ACTION_TIMEOUT_MS,
          });
        } catch (_) {
          await tombolSelanjutnya.click({
            force: true,
            timeout: PAGE_ACTION_TIMEOUT_MS,
          });
        }

        // Beri waktu transisi React/Next sebelum deteksi halaman berikutnya.
        await pagePolling.waitForTimeout(1500);
        return;
      }
    }

    if (Date.now() >= waktuLogBerikutnya) {
      const sisaDetik = Math.max(
        0,
        Math.ceil((deadline - Date.now()) / 1000)
      );

      cetakStatusLive(
        `[Tombol Selanjutnya belum aktif... sisa toleransi ${sisaDetik} detik]`
      );

      waktuLogBerikutnya =
        Date.now() + EMAIL_VERIFICATION_STATUS_INTERVAL_MS;
    }

    await pagePolling.waitForTimeout(EMAIL_VERIFICATION_POLL_MS);
  }

  throw new Error(
    `Tombol Selanjutnya belum aktif setelah ${Math.round(
      EMAIL_VERIFICATION_TIMEOUT_MS / 1000
    )} detik.`
  );
}

async function locatorTerlihat(locator) {
  try {
    return await locator.isVisible();
  } catch (_) {
    return false;
  }
}

async function locatorAda(locator) {
  try {
    return (await locator.count()) > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Melakukan scroll secara bertahap menggunakan kombinasi:
 * 1. mouse wheel agar pergerakan terlihat di browser;
 * 2. window/document scroll;
 * 3. seluruh container yang mempunyai scrollHeight;
 * 4. PageDown dan End sebagai fallback.
 *
 * Fungsi berhenti setelah checkbox/tombol persetujuan terlihat atau halaman
 * benar-benar sudah berada di bagian paling bawah.
 */
async function scrollHalamanPrivasiSampaiBawah({
  pagePolling,
  checkboxPrivasi,
  tulisanPersetujuan,
  tombolSetuju,
  cetakStatusLive,
}) {
  const ukuranViewport = await pagePolling.evaluate(() => ({
    width: window.innerWidth || 1280,
    height: window.innerHeight || 720,
  }));

  await pagePolling.mouse.move(
    Math.floor(ukuranViewport.width / 2),
    Math.floor(ukuranViewport.height / 2)
  );

  // Fokuskan halaman supaya PageDown/End diarahkan ke halaman aktif.
  await pagePolling.locator('body').click({
    position: {
      x: Math.max(1, Math.floor(ukuranViewport.width / 2)),
      y: Math.max(1, Math.floor(ukuranViewport.height / 2)),
    },
    force: true,
  }).catch(() => {});

  let posisiSebelumnya = '';
  let stabil = 0;

  for (let putaran = 1; putaran <= 35; putaran += 1) {
    const kontrolSudahTerlihat =
      (await locatorTerlihat(checkboxPrivasi)) ||
      (await locatorTerlihat(tulisanPersetujuan)) ||
      (await locatorTerlihat(tombolSetuju));

    const posisi = await pagePolling.evaluate(() => {
      const root =
        document.scrollingElement ||
        document.documentElement ||
        document.body;

      const seluruhElemen = Array.from(document.querySelectorAll('*'));
      const scrollables = seluruhElemen.filter(
        (elemen) =>
          elemen.scrollHeight > elemen.clientHeight + 5 &&
          elemen.clientHeight > 0
      );

      // Scroll halaman utama secara bertahap, bukan langsung melompat.
      const langkah = Math.max(
        Math.floor((window.innerHeight || 720) * 0.8),
        500
      );

      window.scrollBy(0, langkah);

      if (root) {
        root.scrollTop = Math.min(
          root.scrollTop + langkah,
          root.scrollHeight
        );
      }

      // Beberapa aplikasi React/Next memakai wrapper sebagai scroll container.
      for (const elemen of scrollables) {
        elemen.scrollTop = Math.min(
          elemen.scrollTop + langkah,
          elemen.scrollHeight
        );
        elemen.dispatchEvent(new Event('scroll', { bubbles: true }));
      }

      const posisiContainer = scrollables
        .slice(0, 12)
        .map((elemen) => ({
          top: Math.round(elemen.scrollTop),
          max: Math.round(elemen.scrollHeight - elemen.clientHeight),
        }));

      const rootTop = root ? Math.round(root.scrollTop) : 0;
      const rootMax = root
        ? Math.max(0, Math.round(root.scrollHeight - root.clientHeight))
        : 0;

      return {
        rootTop,
        rootMax,
        posisiContainer,
      };
    });

    // Mouse wheel membuat scroll benar-benar terlihat pada Chrome.
    await pagePolling.mouse.wheel(
      0,
      Math.max(Math.floor(ukuranViewport.height * 0.85), 600)
    );

    // Fallback untuk layout yang hanya merespons input keyboard.
    if (putaran % 3 === 0) {
      await pagePolling.keyboard.press('PageDown').catch(() => {});
    }

    await pagePolling.waitForTimeout(250);

    const posisiSekarang = JSON.stringify(posisi);

    if (posisiSekarang === posisiSebelumnya) {
      stabil += 1;
    } else {
      stabil = 0;
      posisiSebelumnya = posisiSekarang;
    }

    const containerSudahBawah = posisi.posisiContainer.every(
      (item) => item.max <= 0 || item.top >= item.max - 3
    );
    const halamanSudahBawah =
      posisi.rootMax <= 0 || posisi.rootTop >= posisi.rootMax - 3;

    if (kontrolSudahTerlihat && (halamanSudahBawah || containerSudahBawah)) {
      break;
    }

    if (stabil >= 4) {
      break;
    }
  }

  cetakStatusLive('[Memastikan posisi benar-benar di bagian paling bawah...]');

  // Paksa seluruh kemungkinan scroll container ke posisi terakhir.
  await pagePolling.evaluate(() => {
    const root =
      document.scrollingElement ||
      document.documentElement ||
      document.body;

    window.scrollTo(0, Number.MAX_SAFE_INTEGER);

    if (root) {
      root.scrollTop = root.scrollHeight;
      root.dispatchEvent(new Event('scroll', { bubbles: true }));
    }

    for (const elemen of document.querySelectorAll('*')) {
      if (elemen.scrollHeight > elemen.clientHeight + 5) {
        elemen.scrollTop = elemen.scrollHeight;
        elemen.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    }
  });

  await pagePolling.mouse.wheel(0, 10000).catch(() => {});
  await pagePolling.keyboard.press('End').catch(() => {});
  await pagePolling.waitForTimeout(1000);
}

async function tungguKondisiHalaman({
  modalOtp,
  penandaPrivasi,
  checkboxPrivasi,
  tulisanPersetujuan,
  tombolSetuju,
  timeoutMs = 10000,
}) {
  const batasWaktu = Date.now() + timeoutMs;

  while (Date.now() < batasWaktu) {
    if (await locatorTerlihat(modalOtp)) {
      return 'OTP_LANGSUNG';
    }

    const halamanPrivasiTerdeteksi =
      (await locatorTerlihat(penandaPrivasi)) ||
      (await locatorAda(penandaPrivasi)) ||
      (await locatorTerlihat(checkboxPrivasi)) ||
      (await locatorTerlihat(tulisanPersetujuan)) ||
      (await locatorTerlihat(tombolSetuju));

    if (halamanPrivasiTerdeteksi) {
      return 'PRIVASI';
    }

    await sleep(250);
  }

  return 'TIDAK_TERDETEKSI';
}

async function centangPersetujuanPrivasi({
  pagePolling,
  checkboxPrivasi,
  tulisanPersetujuan,
  tombolSetuju,
}) {
  let persetujuanBerhasil = false;

  // Tunggu sebentar karena checkbox kadang baru aktif setelah event scroll.
  const batasWaktu = Date.now() + 10000;

  while (Date.now() < batasWaktu) {
    const inputCheckbox = pagePolling
      .locator('input[type="checkbox"]:visible')
      .last();

    if ((await inputCheckbox.count()) > 0) {
      try {
        await inputCheckbox.scrollIntoViewIfNeeded();

        if (!(await inputCheckbox.isChecked())) {
          try {
            await inputCheckbox.check({ timeout: 3000 });
          } catch (_) {
            await inputCheckbox.check({
              force: true,
              timeout: 3000,
            });
          }
        }

        if (await inputCheckbox.isChecked()) {
          persetujuanBerhasil = true;
          break;
        }
      } catch (_) {
        // Coba metode berikutnya.
      }
    }

    const roleCheckbox = pagePolling
      .locator('[role="checkbox"]:visible')
      .last();

    if ((await roleCheckbox.count()) > 0) {
      try {
        await roleCheckbox.scrollIntoViewIfNeeded();

        const kondisiAwal = await roleCheckbox.getAttribute('aria-checked');
        if (kondisiAwal !== 'true') {
          await roleCheckbox.click({ force: true });
        }

        const kondisiAkhir = await roleCheckbox.getAttribute('aria-checked');
        if (kondisiAkhir === 'true' || kondisiAkhir === null) {
          persetujuanBerhasil = true;
          break;
        }
      } catch (_) {
        // Coba metode berikutnya.
      }
    }

    if (await locatorTerlihat(tulisanPersetujuan)) {
      try {
        await tulisanPersetujuan.scrollIntoViewIfNeeded();
        await tulisanPersetujuan.click({ force: true });
        persetujuanBerhasil = true;
        break;
      } catch (_) {
        // Tunggu lalu ulangi.
      }
    }

    await pagePolling.waitForTimeout(300);
  }

  if (!persetujuanBerhasil) {
    throw new Error(
      'Sudah scroll sampai bawah, tetapi checkbox persetujuan tidak ditemukan atau belum aktif.'
    );
  }

  await pagePolling.waitForTimeout(500);

  // Beberapa variasi halaman menyediakan tombol Setuju setelah checkbox aktif.
  if (await locatorTerlihat(tombolSetuju)) {
    await tombolSetuju.scrollIntoViewIfNeeded();

    try {
      await tombolSetuju.click({ timeout: 5000 });
    } catch (_) {
      await tombolSetuju.click({
        force: true,
        timeout: 5000,
      });
    }

    await pagePolling.waitForTimeout(750);
  }
}

async function bukaModalOtpDenganPrivasiOpsional({
  pagePolling,
  cetakStatusLive,
}) {
  const modalBtn = pagePolling
    .locator('button:has-text("Masukkan Kode")')
    .first();

  // Penanda ini sudah terlihat sejak bagian atas halaman pada screenshot,
  // sehingga halaman privasi dapat dideteksi sebelum checkbox muncul.
  const penandaPrivasi = pagePolling
    .locator(
      'text=/Kebijakan Privasi|Syarat dan Ketentuan Polling|Langkah\\s*\\d+\\s*dari\\s*\\d+/i'
    )
    .first();

  const tulisanPersetujuan = pagePolling
    .locator(
      'text=/Dengan mengklik.*(menyatakan telah membaca|ketentuan yang berlaku)|Saya.*(setuju|membaca).*ketentuan/i'
    )
    .last();

  const tombolSetuju = pagePolling
    .locator('button:has-text("Setuju"):visible')
    .last();

  const checkboxPrivasi = pagePolling
    .locator(
      'input[type="checkbox"]:visible, [role="checkbox"]:visible'
    )
    .last();

  const kondisiAwal = await tungguKondisiHalaman({
    modalOtp: modalBtn,
    penandaPrivasi,
    checkboxPrivasi,
    tulisanPersetujuan,
    tombolSetuju,
    timeoutMs: 10000,
  });

  if (kondisiAwal === 'OTP_LANGSUNG') {
    cetakStatusLive('[Halaman Privasi tidak muncul, langsung ke OTP...]');
    return modalBtn;
  }

  // Teks "Langkah 1 dari 2" menunjukkan halaman dapat terdiri atas lebih
  // dari satu tahap. Ulangi maksimal empat kali sampai tombol OTP tersedia.
  for (let tahap = 1; tahap <= 4; tahap += 1) {
    if (await locatorTerlihat(modalBtn)) {
      return modalBtn;
    }

    const privasiMasihTerlihat =
      (await locatorTerlihat(penandaPrivasi)) ||
      (await locatorAda(penandaPrivasi));

    if (privasiMasihTerlihat || tahap === 1) {
      cetakStatusLive(
        `[Halaman Privasi tahap ${tahap} terdeteksi, melakukan scroll bertahap...]`
      );

      await scrollHalamanPrivasiSampaiBawah({
        pagePolling,
        checkboxPrivasi,
        tulisanPersetujuan,
        tombolSetuju,
        cetakStatusLive,
      });

      cetakStatusLive(
        `[Memilih cek persetujuan pada tahap ${tahap}...]`
      );

      await centangPersetujuanPrivasi({
        pagePolling,
        checkboxPrivasi,
        tulisanPersetujuan,
        tombolSetuju,
      });
    }

    if (await locatorTerlihat(modalBtn)) {
      return modalBtn;
    }

    // Setelah checkbox dipilih, tombol Selanjutnya biasanya berada di bawah.
    const tombolSelanjutnya = pagePolling
      .locator('button:has-text("Selanjutnya"):visible')
      .last();

    if (await locatorTerlihat(tombolSelanjutnya)) {
      await tombolSelanjutnya.scrollIntoViewIfNeeded();

      try {
        await tombolSelanjutnya.click({ timeout: 5000 });
      } catch (_) {
        await tombolSelanjutnya.click({
          force: true,
          timeout: 5000,
        });
      }

      await pagePolling.waitForTimeout(1000);
    } else if (!(await locatorTerlihat(modalBtn))) {
      // Pada beberapa variasi, tombol lanjut menggunakan teks lain.
      const tombolLanjutAlternatif = pagePolling
        .locator(
          'button:has-text("Lanjut"):visible, button[type="submit"]:visible'
        )
        .last();

      if (await locatorTerlihat(tombolLanjutAlternatif)) {
        await tombolLanjutAlternatif.scrollIntoViewIfNeeded();
        await tombolLanjutAlternatif.click({ force: true });
        await pagePolling.waitForTimeout(1000);
      }
    }
  }

  await modalBtn.waitFor({
    state: 'visible',
    timeout: 15000,
  });

  return modalBtn;
}

async function hapusOtpSetelahSukses({
  otpEmailRef,
  gmailOtp,
  appsPassword,
  cetakStatusLive,
  maksimalPercobaan = 3,
}) {
  if (!otpEmailRef?.uid) {
    throw new Error(
      'UID email OTP tidak tersedia sehingga email tidak dapat dibersihkan.'
    );
  }

  let errorTerakhir = null;

  for (
    let percobaan = 1;
    percobaan <= maksimalPercobaan;
    percobaan += 1
  ) {
    try {
      cetakStatusLive(
        `[Menghapus Email OTP, percobaan ${percobaan}/${maksimalPercobaan}...]`
      );

      const hasilHapus = await pindahkanOtpKeTrash({
        emailUser: gmailOtp,
        emailPass: appsPassword,
        uid: Number(otpEmailRef.uid),
        messageId: otpEmailRef.messageId || null,
        sender: OTP_SENDER,
        subject: otpEmailRef.subject || OTP_SUBJECT,
        receivedAt: otpEmailRef.receivedAt || null,
      });

      const tujuan = hasilHapus.trashBox
        ? `folder ${hasilHapus.trashBox}`
        : 'keluar dari INBOX';

      console.log(
        `\n[OTP] Email berhasil dibersihkan ke ${tujuan}. ` +
        `Metode: ${hasilHapus.metode}; UID awal: ${hasilHapus.uid}; ` +
        `UID terdeteksi: ${hasilHapus.resolvedUid}; ` +
        `verifikasi: ${hasilHapus.verified ? 'berhasil' : 'tidak tersedia'}.`
      );

      return hasilHapus;
    } catch (error) {
      errorTerakhir = error;

      console.error(
        `\n[OTP] Percobaan hapus ${percobaan}/${maksimalPercobaan} gagal: ` +
        `${error.message}`
      );

      if (percobaan < maksimalPercobaan) {
        await sleep(3000);
      }
    }
  }

  throw new Error(
    `Email OTP gagal dibersihkan setelah ${maksimalPercobaan} percobaan. ` +
    `Error terakhir: ${errorTerakhir?.message || 'tidak diketahui'}`
  );
}

// ==========================================================
// PROGRAM UTAMA
// ==========================================================

(async () => {
  let browser = null;

  try {
    console.log('=== PERSIAPAN DATA AWAL ===');

    // ==========================================================
    // BACA KONFIGURASI DARI FILE config.txt
    // ==========================================================
    const CONFIG_PATH = path.join(__dirname, 'config.txt');

    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(
        'File config.txt tidak ditemukan. ' +
        'Buka file config.txt dan isi data Anda.'
      );
    }

    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = {};

    for (const line of configRaw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (key && val) config[key] = val;
    }

    const FILE_LIST_EMAIL = path.resolve(
      __dirname,
      config.FILE_LIST_EMAIL || 'list_email.example.txt'
    );
    let rawFolderCapture = config.FOLDER_CAPTURE || './capture';
    // Fallback otomatis ke folder bawaan jika user masih menggunakan konfigurasi lama
    if (rawFolderCapture.includes('CONTOH/PATH')) {
      rawFolderCapture = './capture';
    }
    const FOLDER_CAPTURE = path.resolve(__dirname, rawFolderCapture);
    const GMAIL_OTP = config.GMAIL_OTP || '';
    const APPS_PASSWORD = config.APPS_PASSWORD || '';

    if (!GMAIL_OTP || !APPS_PASSWORD) {
      throw new Error(
        'Isi GMAIL_OTP dan APPS_PASSWORD di file config.txt'
      );
    }
    // ==========================================================

    console.log(`File list email          : ${FILE_LIST_EMAIL}`);
    console.log(`Folder capture           : ${FOLDER_CAPTURE}`);
    console.log(`Gmail OTP                : ${GMAIL_OTP}`);

    const appsPassword = APPS_PASSWORD.replace(/\s+/g, '');
    const folderCapture = siapkanFolderCapture(FOLDER_CAPTURE);

    console.log(`Folder capture aktif     : ${folderCapture}`);

    if (!fs.existsSync(FILE_LIST_EMAIL)) {
      throw new Error(`File ${FILE_LIST_EMAIL} tidak ditemukan.`);
    }

    const semuaEmail = bacaDaftarEmail(FILE_LIST_EMAIL);
    const fileHistory = dapatkanFileHistoryHariIni();
    const emailSudahProses = fs.existsSync(fileHistory)
      ? bacaDaftarEmail(fileHistory)
      : [];

    const seluruhTargetBelumProses = semuaEmail.filter(
      (email) => !emailSudahProses.includes(email)
    );

    // Hanya satu data untuk pengujian setiap kali script dijalankan.
    const targetEmail = seluruhTargetBelumProses.slice(0, TEST_LIMIT);

    console.log(`\nTotal email di list      : ${semuaEmail.length}`);
    console.log(`Sudah diproses hari ini  : ${emailSudahProses.length}`);
    console.log(`Belum diproses           : ${seluruhTargetBelumProses.length}`);
    console.log(`Dijalankan pada test ini : ${targetEmail.length}`);

    if (targetEmail.length === 0) {
      console.log('Tidak ada email test yang tersisa untuk hari ini.');
      return;
    }

    await jalankanChrome();

    console.log('=== Menghubungkan ke Google Chrome... ===\n');
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${CHROME_DEBUG_PORT}`
    );

    const context = browser.contexts()[0];
    if (!context) {
      throw new Error('Browser context Chrome tidak ditemukan.');
    }

    let jumlahSukses = 0;
    let jumlahGagal = 0;
    const totalTarget = targetEmail.length;

    for (let index = 0; index < totalTarget; index += 1) {
      const emailSaatIni = targetEmail[index];
      const urutan = index + 1;
      const startTime = ambilWaktu();
      let statusAkhir = 'Gagal';
      let pagePolling = null;
      let otpEmailRef = null;

      const teksPrefix =
        `Data ${urutan} (${emailSaatIni}) start time: ${startTime}` +
        ' | Status: >>> ';

      const cetakStatusLive = (langkahTeks) => {
        process.stdout.write(`\r\x1b[K${teksPrefix}${langkahTeks}\n`);
        process.stdout.write(
          `\r\x1b[K${urutan}/${totalTarget} | success: ${jumlahSukses} | gagal: ${jumlahGagal}`
        );
        process.stdout.write('\x1b[1A');
      };

      try {
        pagePolling = await context.newPage();
        pagePolling.setDefaultTimeout(PAGE_ACTION_TIMEOUT_MS);
        pagePolling.setDefaultNavigationTimeout(60000);

        // Step 1: Buka halaman.
        cetakStatusLive('[Membuka Web Danantara...]');
        await pagePolling.goto(TARGET_URL, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Step 2-4: Isi email, tunggu validasi asynchronous,
        // pilih persetujuan, lalu tunggu tombol Selanjutnya benar-benar aktif.
        await setujuiDanKlikLanjutDepan({
          pagePolling,
          emailSaatIni,
          cetakStatusLive,
        });

        // Step 5: Tangani halaman privasi yang bersifat opsional
        // sekaligus lanjut sampai tombol OTP tersedia.
        const modalBtn = await bukaModalOtpDenganPrivasiOpsional({
          pagePolling,
          cetakStatusLive,
        });

        // Step 6: Minta OTP.
        cetakStatusLive('[Membuka Pop-up OTP...]');

        // Waktu dicatat sesaat sebelum tombol yang meminta OTP ditekan.
        const waktuKlikOTP = new Date();
        await modalBtn.click({ force: true });

        // Step 7: Ambil OTP terbaru beserta UID email.
        cetakStatusLive('[Menunggu Kode Masuk di Gmail...]');

        otpEmailRef = await tungguOtpTerbaru({
          emailUser: GMAIL_OTP,
          emailPass: appsPassword,
          waktuRequest: waktuKlikOTP,
          sender: OTP_SENDER,
          subject: OTP_SUBJECT,
          otpLength: 4,
          timeoutMs: 120000,
          intervalMs: 5000,
          clockSkewMs: 120000,
        });

        const otpCode = otpEmailRef.otp;
        if (!/^\d{4}$/.test(otpCode)) {
          throw new Error(`Format OTP tidak valid: ${otpCode}`);
        }

        // Step 8: Masukkan OTP.
        cetakStatusLive(`[Mengisi Kode OTP: ${otpCode}...]`);

        const otpInputs = pagePolling.locator('input[type="text"]');
        const jumlahOtpInput = await otpInputs.count();

        if (jumlahOtpInput < otpCode.length) {
          throw new Error(
            `Kolom OTP tidak mencukupi. Ditemukan ${jumlahOtpInput}, diperlukan ${otpCode.length}.`
          );
        }

        for (let digit = 0; digit < otpCode.length; digit += 1) {
          await otpInputs.nth(digit).fill(otpCode[digit]);
        }

        await pagePolling.waitForTimeout(2000);

        // Step 9: Cari perusahaan.
        cetakStatusLive('[Mencari "Pegadaian"...]');

        const searchInput = pagePolling
          .locator('input[placeholder*="Cari"], input[placeholder*="BUMN"]')
          .first();

        await searchInput.waitFor({ state: 'visible', timeout: 15000 });
        await searchInput.fill('pegad');
        await pagePolling.waitForTimeout(1500);

        const opsiPegadaianDropdown = pagePolling
          .getByText('Pegadaian', { exact: true })
          .first();

        try {
          await opsiPegadaianDropdown.click({ force: true });
        } catch (_) {
          await searchInput.press('Enter');
        }

        // Step 10: Isi kuesioner test.
        cetakStatusLive('[Mengisi Kuesioner...]');

        await pagePolling
          .getByText(/Mudah menemukan informasi produk dan layanan/i)
          .first()
          .waitFor({ state: 'visible', timeout: 20000 });

        await pagePolling
          .getByText(/Mudah menemukan informasi produk dan layanan/i)
          .first()
          .click({ force: true });
        await pagePolling
          .getByText(/Hasil pembiayaan sesuai/i)
          .first()
          .click({ force: true });
        await pagePolling
          .getByText(/Keluhan ditangani/i)
          .first()
          .click({ force: true });

        const btnLanjutKuesioner = pagePolling.locator(
          'button:has-text("Lanjut")'
        );
        await btnLanjutKuesioner.first().click({ force: true });

        // Step 11: Konfirmasi perusahaan.
        cetakStatusLive('[Memilih Perusahaan...]');

        const teksPegadaianList = pagePolling
          .getByText('Pegadaian', { exact: true })
          .last();
        await teksPegadaianList.waitFor({ state: 'visible', timeout: 10000 });
        await teksPegadaianList.click({ force: true });
        await btnLanjutKuesioner.last().click({ force: true });

        // Step 12: Tunggu sukses dan simpan screenshot.
        cetakStatusLive('[Menyimpan Screenshot...]');

        await pagePolling
          .getByText('Terima Kasih Atas Partisipasinya', { exact: false })
          .first()
          .waitFor({ state: 'visible', timeout: 15000 });

        await pagePolling.waitForTimeout(1000);

        const namaFileGambar = path.join(
          folderCapture,
          `bukti_${sanitasiNamaFile(emailSaatIni)}_` +
          `[${ambilTimestampFile()}].png`
        );

        try {
          const areaBukti = pagePolling
            .locator(
              'div[class*="modal"], div[class*="card"], div[class*="popup"], .bg-white'
            )
            .filter({ hasText: 'Terima Kasih Atas Partisipasinya' })
            .first();

          await areaBukti.screenshot({ path: namaFileGambar });
        } catch (_) {
          await pagePolling.screenshot({
            path: namaFileGambar,
            fullPage: true,
          });
        }

        console.log(`\n[CAPTURE] Screenshot disimpan: ${namaFileGambar}`);

        // Setelah screenshot selesai, bersihkan email OTP terlebih dahulu.
        // Fungsi melakukan retry dan verifikasi agar kegagalan tidak terlewat.
        await hapusOtpSetelahSukses({
          otpEmailRef,
          gmailOtp: GMAIL_OTP,
          appsPassword,
          cetakStatusLive,
          maksimalPercobaan: 3,
        });

        // History baru dicatat setelah web dan pembersihan OTP sama-sama sukses.
        fs.appendFileSync(fileHistory, `${emailSaatIni}\n`, 'utf8');

        statusAkhir = 'Success';
        jumlahSukses += 1;
      } catch (error) {
        statusAkhir = 'Gagal';
        jumlahGagal += 1;

        console.error('\n========================================');
        console.error(`[ERROR] Email: ${emailSaatIni}`);
        console.error(error.stack || error.message || error);
        console.error('========================================');
      } finally {
        const endTime = ambilWaktu();

        process.stdout.write('\r\x1b[K\n');
        console.log(
          `Data ${urutan} (${emailSaatIni}) start time: ${startTime} ` +
            `end time: ${endTime} >>> ${statusAkhir}`
        );
        console.log(
          `${urutan}/${totalTarget} | success: ${jumlahSukses} | gagal: ${jumlahGagal}`
        );

        if (pagePolling) {
          await pagePolling.close().catch(() => {});
        }
      }
    }

    console.log('\n=== SEMUA TAHAPAN OTOMASI TEST SELESAI ===');
  } catch (error) {
    console.error('\n[ERROR UTAMA]');
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  } finally {
    // connectOverCDP terhubung ke Chrome milik pengguna. Tidak memanggil
    // browser.close() agar seluruh Chrome tidak ikut tertutup.
    browser = null;
  }
})();
