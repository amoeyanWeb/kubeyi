const app = (() => {
  // ══════════════════════════════════════
  // STATE
  // ══════════════════════════════════════

  const ESHARAH_TOTAL_DURATION = 100; // زمان کل اشاره به میلی‌ثانیه

  let state = {
    name: "",
    meter: "2/4",
    tempo: 120,
    cols: 8, // = numerator * 2
    rows: [], // array of arrays [cols]
    dynamics: [], // array of arrays [cols] — هر خانه: '', 'ff','f','mf','mp','p','pp','<','>','<>'
    triplets: {}, // { "ri-ci": { type, baseCols, slots } }
    tupletDynamics: {}, // { "ri-ci-slot": dynKey } برای slot‌های اضافی tuplet
    selected: -1, // selected row index (0-based)
    clipboard: null,
    clipboardDynamics: null,
    filename: "",
    dirty: false,
  };

  // در ابتدای تنظیمات صوتی یا کانفینگ‌های اصلی برنامه (مثلاً در ابتدای app.js یا بخش پخش‌کننده)

  // ══════════════════════════════════════
  // AUTOSAVE (ذخیره خودکار در حافظه مرورگر)
  // ══════════════════════════════════════
  const AUTOSAVE_KEY = "buskit_rhythm_autosave_v1";
  let autosaveTimer = null;

  // فوری وضعیت فعلی را در localStorage می‌نویسد
  function persistAutosave() {
    try {
      localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error("Autosave error:", e);
    }
  }

  // نوشتن با تاخیر کوتاه، تا تایپ پشت‌سرهم باعث نوشتن مکرر نشود
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(persistAutosave, 600);
  }

  // جایگزین state.dirty = true → هم dirty می‌کند هم autosave را زمان‌بندی می‌کند
  function markDirty() {
    state.dirty = true;
    scheduleAutosave();
  }

  function clearAutosave() {
    try {
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch (e) {}
  }

  // در لود اولیه صفحه: اگر نسخه ذخیره‌نشده‌ای از قبل باقی مانده، از کاربر می‌پرسد
  function checkAutosaveOnLoad() {
    let raw;
    try {
      raw = localStorage.getItem(AUTOSAVE_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    let saved;
    try {
      saved = JSON.parse(raw);
    } catch (e) {
      return;
    }
    if (!saved || !saved.dirty || !saved.name) return;
    const ok = window.confirm(
      `یک نسخه‌ی ذخیره‌نشده از قطعه «${saved.name}» پیدا شد (احتمالاً قبلاً بدون ذخیره خارج شده‌اید).\nمی‌خواهید آن را بازیابی کنید؟`,
    );
    if (ok) {
      state = { esharahSettings: {}, ...saved };
      render();
      updateStatus();
      toast(`نسخه‌ی ذخیره‌نشده‌ی «${saved.name}» بازیابی شد ✓`);
    } else {
      clearAutosave();
    }
  }

  // قبل از ترک/بسته‌شدن صفحه، آخرین وضعیت را تضمین می‌کنیم که نوشته شده باشد.
  // beforeunload روی موبایل (سوییچ بین اپ‌ها، قفل‌کردن گوشی، بستن تب) معمولاً
  // فایر نمی‌شود؛ به همین خاطر از visibilitychange و pagehide هم استفاده می‌کنیم
  // که روی موبایل قابل‌اعتمادتر هستند.
  function flushAutosaveIfDirty() {
    if (state.dirty) {
      clearTimeout(autosaveTimer);
      persistAutosave();
    }
  }
  window.addEventListener("beforeunload", flushAutosaveIfDirty);
  window.addEventListener("pagehide", flushAutosaveIfDirty);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAutosaveIfDirty();
  });

  // ══════════════════════════════════════
  // DYNAMICS (نوانس‌ها)
  // ══════════════════════════════════════
  // ترتیب نمایش در منو طبق درخواست: ff f mf mp p pp، سپس نشانه‌های قوسی/ترمولو
  const DYNAMICS_MAIN = [
    { key: "ff", cssVar: "--dyn-ff", bgVar: "--dyn-ff-bg" },
    { key: "f", cssVar: "--dyn-f", bgVar: "--dyn-f-bg" },
    { key: "mf", cssVar: "--dyn-mf", bgVar: "--dyn-mf-bg" },
    { key: "mp", cssVar: "--dyn-mp", bgVar: "--dyn-mp-bg" },
    { key: "p", cssVar: "--dyn-p", bgVar: "--dyn-p-bg" },
    { key: "pp", cssVar: "--dyn-pp", bgVar: "--dyn-pp-bg" },
  ];
  const DYNAMICS_SHAPE = [
    { key: "<", cssVar: "--dyn-cresc", bgVar: "--dyn-cresc-bg" },
    { key: ">", cssVar: "--dyn-decresc", bgVar: "--dyn-decresc-bg" },
    { key: "<>", cssVar: "--dyn-swell", bgVar: "--dyn-swell-bg" },
  ];
  const DYNAMICS_ALL = [...DYNAMICS_MAIN, ...DYNAMICS_SHAPE];

  // حجم صدا برای هر سطح نوانس — اینجا قابل تنظیم است
  const DYNAMIC_GAIN = {
    "": 0.75, // حالت عادی = هم‌اندازه mf
    mf: 0.75,
    ff: 1.0,
    f: 0.88,
    mp: 0.6,
    p: 0.45,
    pp: 0.3,
  };
  // برای نشانه‌های قوسی (کرشندو/دیکرشندو/قوسی) نسبت بلندترین به ساکت‌ترین نقطه
  const SHAPE_LOW_RATIO = 0.35;

  function isShapeDynamic(d) {
    return d === "<" || d === ">" || d === "<>";
  }

  function getCellDynamic(ri, ci) {
    return (state.dynamics[ri] && state.dynamics[ri][ci]) || "";
  }

  // ══════════════════════════════════════
  // DYNAMICS MENU (پاپ‌آپ انتخاب نوانس)
  // ══════════════════════════════════════
  let dynMenuState = { ri: -1, ci: -1 };

  function closeDynamicsMenu() {
    const menu = document.getElementById("dynamics-menu");
    if (menu) menu.classList.remove("show");
    dynMenuState = { ri: -1, ci: -1 };
  }

  function buildDynOption(def, ri, ci, current) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dyn-opt" + (current === def.key ? " active" : "");
    btn.style.color = `var(${def.cssVar})`;
    btn.textContent = def.key;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCellDynamic(ri, ci, def.key);
      closeDynamicsMenu();
    });
    return btn;
  }

  function openDynamicsMenu(ri, ci, anchorEl) {
    const menu = document.getElementById("dynamics-menu");
    if (!menu) return;
    dynMenuState = { ri, ci };
    const current = getCellDynamic(ri, ci);
    menu.innerHTML = "";

    const rowMain = document.createElement("div");
    rowMain.className = "dyn-menu-row";
    DYNAMICS_MAIN.forEach((def) =>
      rowMain.appendChild(buildDynOption(def, ri, ci, current)),
    );
    menu.appendChild(rowMain);

    const divider = document.createElement("div");
    divider.className = "dyn-menu-divider";
    menu.appendChild(divider);

    const rowShape = document.createElement("div");
    rowShape.className = "dyn-menu-row";
    DYNAMICS_SHAPE.forEach((def) =>
      rowShape.appendChild(buildDynOption(def, ri, ci, current)),
    );
    menu.appendChild(rowShape);

    const rowReset = document.createElement("div");
    rowReset.className = "dyn-menu-row";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "dyn-opt reset" + (current === "" ? " active" : "");
    resetBtn.textContent = "حالت عادی";
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setCellDynamic(ri, ci, "");
      closeDynamicsMenu();
    });
    rowReset.appendChild(resetBtn);
    menu.appendChild(rowReset);

    menu.classList.add("show");
    // موقعیت‌دهی نسبت به سلول، با درنظرگرفتن مرز صفحه
    const rect = anchorEl.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = rect.left;
    if (left + menuRect.width > window.innerWidth - 8) {
      left = window.innerWidth - menuRect.width - 8;
    }
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 8) {
      top = rect.top - menuRect.height - 4;
    }
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  function setCellDynamic(ri, ci, key) {
    if (!state.dynamics[ri]) state.dynamics[ri] = Array(state.cols).fill("");
    state.dynamics[ri][ci] = key;
    markDirty();
    render();
    updateStatus();
  }

  document.addEventListener("click", (e) => {
    const menu = document.getElementById("dynamics-menu");
    if (!menu || !menu.classList.contains("show")) return;
    if (!menu.contains(e.target)) closeDynamicsMenu();
  });

  // ══════════════════════════════════════
  // CELL CONTEXT MENU (رایت‌کلیک روی خانه دارای تکنیک)
  // ══════════════════════════════════════
  let _cellCtxOpen = false;

  function closeCellContextMenu() {
    const menu = document.getElementById("cell-context-menu");
    if (menu) menu.classList.remove("show");
    _cellCtxOpen = false;
  }

  function openCellContextMenu(ri, ci, anchorEl) {
    let menu = document.getElementById("cell-context-menu");
    if (!menu) {
      menu = document.createElement("div");
      menu.id = "cell-context-menu";
      document.body.appendChild(menu);
    }

    closeDynamicsMenu();
    closeCellContextMenu();

    _cellCtxOpen = true;
    selectRow(ri);

    const current = getCellDynamic(ri, ci);

    // ساخت آیتم‌های dynamics
    const dynOptionsHTML = DYNAMICS_MAIN.map(d =>
      `<button class="rcm-item ccm-dyn-btn${current === d.key ? ' ccm-active' : ''}" style="color:var(${d.cssVar})" data-ri="${ri}" data-ci="${ci}" data-dyn="${d.key}">${d.key}</button>`
    ).join('');

    const shapeOptionsHTML = DYNAMICS_SHAPE.map(d =>
      `<button class="rcm-item ccm-dyn-btn${current === d.key ? ' ccm-active' : ''}" style="color:var(${d.cssVar})" data-ri="${ri}" data-ci="${ci}" data-dyn="${d.key}">${d.key}</button>`
    ).join('');

    menu.innerHTML = `
      <div class="rcm-header">میزان ${ri + 1} · تکنیک ${ci + 1}</div>
      <div class="ccm-dyn-section">
        <div class="ccm-dyn-label">نوانس</div>
        <div class="ccm-dyn-row">${dynOptionsHTML}</div>
        <div class="ccm-dyn-row">${shapeOptionsHTML}</div>
        <button class="rcm-item ccm-dyn-btn ccm-reset${current === '' ? ' ccm-active' : ''}" data-ri="${ri}" data-ci="${ci}" data-dyn="">حالت عادی</button>
      </div>
      <div class="rcm-divider"></div>
      <button class="rcm-item ccm-tuplet-btn">
        <span class="rcm-icon">𝄾</span> گروه ریتمی (Tuplet)
      </button>
    `;

    // attach dynamics click handlers
    menu.querySelectorAll('.ccm-dyn-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const r = parseInt(btn.dataset.ri);
        const c = parseInt(btn.dataset.ci);
        setCellDynamic(r, c, btn.dataset.dyn);
        closeCellContextMenu();
      });
    });

    // attach tuplet click handler
    menu.querySelector('.ccm-tuplet-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      closeCellContextMenu();
      openTripletModal(ci);
    });

    menu.classList.add('show');

    // موقعیت‌دهی هوشمند
    const rect = anchorEl.getBoundingClientRect();
    const menuW = 200;
    const menuH = menu.scrollHeight || 280;
    let left = rect.left;
    if (left + menuW > window.innerWidth - 8) left = window.innerWidth - menuW - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + menuH > window.innerHeight - 8) top = rect.top - menuH - 4;
    if (top < 8) top = 8;
    menu.style.left = (window.scrollX + left) + 'px';
    menu.style.top = (window.scrollY + top) + 'px';
  }

  document.addEventListener('click', (e) => {
    const menu = document.getElementById('cell-context-menu');
    if (!menu || !menu.classList.contains('show')) return;
    if (!menu.contains(e.target)) closeCellContextMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCellContextMenu();
  });

  // ══════════════════════════════════════
  // POLYRHYTHM / TUPLET SYSTEM
  // ══════════════════════════════════════
  // state.triplets = { "ri-ci": { type: "3:2"|"2:3"|"6:4"|"5:4"|"7:6"|"4:3", baseCols, slots } }
  // baseCols = تعداد سلول‌های اصلی گرید که این گروه اشغال می‌کند
  // slots = تعداد نوت‌ها در این گروه
  // زمان هر نوت = (baseCols * cellDur) / slots

  const TUPLET_TYPES = {
    "3:2": {
      label: "3:2",
      slots: 3,
      baseCols: 2,
      color: "triplet",
      desc: "تریوله (3 نوت در فضای 2)",
    },
    "2:3": {
      label: "2:3",
      slots: 2,
      baseCols: 3,
      color: "duplet",
      desc: "دوپله (2 نوت در فضای 3)",
    },
    "6:4": {
      label: "6:4",
      slots: 6,
      baseCols: 4,
      color: "sextuplet",
      desc: "سکستوله (6 نوت در فضای 4)",
    },
    "5:4": {
      label: "5:4",
      slots: 5,
      baseCols: 4,
      color: "quintuplet",
      desc: "پنتوله (5 نوت در فضای 4)",
    },
    "7:6": {
      label: "7:6",
      slots: 7,
      baseCols: 6,
      color: "septuplet",
      desc: "سپتوله (7 نوت در فضای 6)",
    },
    "4:3": {
      label: "4:3",
      slots: 4,
      baseCols: 3,
      color: "quadruplet",
      desc: "کوادروپله (4 نوت در فضای 3)",
    },
    "2:1": {
      label: "\u00BD",
      slots: 2,
      baseCols: 1,
      color: "half",
      desc: "Half \u2014 2 \u0646\u0648\u062a \u0633\u0647\u200c\u0644\u0627\u0686\u0646\u06af \u062f\u0631 \u0641\u0636\u0627\u06cc 1 \u0633\u0644\u0648\u0644",
    },
  };

  // رنگ CSS class برای هر نوع
  // triplet=قرمز, duplet=زرد, sextuplet=بنفش, quintuplet=آبی, septuplet=سبز, quadruplet=نارنجی

  function getTupletAt(ri, ci) {
    return (state.triplets && state.triplets[ri + "-" + ci]) || null;
  }

  // بررسی اینکه ci درون محدوده یک tuplet آغاز شده از startCi است
  function getTupletRole(ri, ci) {
    if (!state.triplets) return null;
    // ci ممکن است start باشد
    if (state.triplets[ri + "-" + ci]) return { startCi: ci };
    // یا درون محدوده یک tuplet باشد
    for (const key of Object.keys(state.triplets)) {
      const [kri, kci] = key.split("-").map(Number);
      if (kri !== ri) continue;
      const t = state.triplets[key];
      if (ci > kci && ci < kci + t.baseCols) return { startCi: kci };
    }
    return null;
  }

  function openTripletModal(ci) {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);

    const modal = document.getElementById("modal-triplet");
    if (!modal) return;

    // ذخیره شماره میزان و شماره تکنیک در dataset مدال
    const ri = state.selected >= 0 ? state.selected : 0;
    modal.dataset.ri = ri;
    modal.dataset.ci = (ci !== undefined && ci >= 0) ? ci : "";

    // پیش‌فرض اولین رادیو
    const radios = document.querySelectorAll('input[name="tuplet-type"]');
    if (radios.length) radios[0].checked = true;

    modal.classList.add("show");
  }

  function confirmTriplet() {
    const modal = document.getElementById("modal-triplet");
    if (!modal) return;

    // خواندن شماره میزان و شماره تکنیک از dataset مدال
    const ri = parseInt(modal.dataset.ri, 10);
    const ci = parseInt(modal.dataset.ci, 10);

    const typeRadio = document.querySelector(
      'input[name="tuplet-type"]:checked',
    );
    if (!typeRadio) return toast("نوع را انتخاب کنید", true);
    const type = typeRadio.value;

    modal.classList.remove("show");

    // --- حذف تیوپلت ---
    if (type === "remove") {
      if (isNaN(ri) || ri < 0 || ri >= state.rows.length)
        return toast("شماره میزان نامعتبر است", true);
      if (isNaN(ci) || ci < 0 || ci >= state.cols)
        return toast("شماره تکنیک نامعتبر است", true);

      let foundKey = null;
      if (state.triplets) {
        if (state.triplets[ri + "-" + ci]) {
          foundKey = ri + "-" + ci;
        } else {
          for (const key of Object.keys(state.triplets)) {
            const [kri, kci] = key.split("-").map(Number);
            if (kri !== ri) continue;
            const t = state.triplets[key];
            if (ci >= kci && ci < kci + t.baseCols) {
              foundKey = key;
              break;
            }
          }
        }
      }
      if (!foundKey) return toast("در این موقعیت گروه ریتمی‌ای یافت نشد", true);
      const [fRi, fCi] = foundKey.split("-").map(Number);
      removeTriplet(fRi, fCi);
      return;
    }

    const def = TUPLET_TYPES[type];
    if (!def) return toast("نوع نامعتبر", true);

    if (isNaN(ri) || ri < 0 || ri >= state.rows.length)
      return toast("شماره میزان نامعتبر است", true);
    if (isNaN(ci) || ci < 0 || ci + def.baseCols > state.cols)
      return toast(
        `شماره تکنیک نامعتبر — این نوع به ${def.baseCols} سلول متوالی نیاز دارد`,
        true,
      );

    // بررسی تداخل
    for (let s = 0; s < def.baseCols; s++) {
      if (getTupletRole(ri, ci + s)) {
        return toast("یکی از سلول‌ها قبلاً عضو گروه ریتمی است", true);
      }
    }

    if (!state.triplets) state.triplets = {};
    state.triplets[ri + "-" + ci] = {
      type,
      baseCols: def.baseCols,
      slots: def.slots,
    };

    if (!state.tripletData) state.tripletData = {};
    for (let s = def.baseCols; s < def.slots; s++) {
      const key = `${ri}-${ci}-${s}`;
      if (!state.tripletData[key]) state.tripletData[key] = "";
    }

    markDirty();
    render();
    toast(
      `${def.desc} در میزان ${ri + 1}، تکنیک ${ci + 1}–${ci + def.baseCols} اعمال شد ✓`,
    );
  }
  function removeTriplet(ri, startCi) {
    if (!state.triplets) return;
    const t = state.triplets[ri + "-" + startCi];
    if (t) {
      // پاک کردن tripletData این گروه
      if (state.tripletData) {
        for (let s = 0; s < t.slots; s++) {
          delete state.tripletData[`${ri}-${startCi}-${s}`];
        }
      }
      // پاک کردن سلول‌های اصلی گرید تا با اسکیل عادی نمایش یابند
      for (let s = 0; s < t.baseCols; s++) {
        if (state.rows[ri]) state.rows[ri][startCi + s] = "";
        if (state.dynamics[ri]) state.dynamics[ri][startCi + s] = "";
      }
      // پاک کردن tupletDynamics این گروه
      if (state.tupletDynamics) {
        for (let s = 0; s < t.slots; s++) {
          delete state.tupletDynamics[`${ri}-${startCi}-${s}`];
        }
      }
    }
    delete state.triplets[ri + "-" + startCi];
    markDirty();
    render();
    toast("گروه ریتمی حذف شد");
  }

  // رندر یک cell گروه ریتمی (tuplet)
  function renderTupletCell(ri, ci, tuplet, rowEl, colsPerBeat) {
    const def = TUPLET_TYPES[tuplet.type] || {
      slots: tuplet.slots,
      baseCols: tuplet.baseCols,
      label: "?",
      color: "triplet",
    };
    const cell = document.createElement("div");
    const beatClass = ci % colsPerBeat === 0 ? " beat-start" : "";
    cell.className = `grid-cell tuplet-cell tuplet-${def.color}${beatClass}`;
    // عرض متناسب با baseCols
    cell.style.minWidth = `calc(var(--cell-w) * ${def.baseCols} + ${def.baseCols - 1}px)`;
    cell.style.width = cell.style.minWidth;

    // label بالا (label + دکمه حذف)
    const labelRow = document.createElement("div");
    labelRow.className = "tuplet-label-row";

    const labelEl = document.createElement("span");
    labelEl.className = "tuplet-label";
    labelEl.textContent = def.label;
    labelRow.appendChild(labelEl);

    const removeBtn = document.createElement("span");
    removeBtn.className = "tuplet-remove";
    removeBtn.textContent = "✕";
    removeBtn.title = "حذف گروه ریتمی";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeTriplet(ri, ci);
    });
    labelRow.appendChild(removeBtn);
    cell.appendChild(labelRow);

    // wrapper سلول‌ها
    const wrapper = document.createElement("div");
    wrapper.className = "tuplet-wrapper";

    if (!state.tripletData) state.tripletData = {};

    for (let slot = 0; slot < def.slots; slot++) {
      const slotDiv = document.createElement("div");
      slotDiv.className = "tuplet-slot";

      // مقدار: slot < baseCols → از row، slot >= baseCols → از tripletData
      let slotVal = "";
      if (slot < def.baseCols) {
        slotVal = state.rows[ri][ci + slot] || "";
      } else {
        slotVal = state.tripletData[`${ri}-${ci}-${slot}`] || "";
      }

      // دینامیک slot — کلید: "ri-ci_slot" در state.dynamics
      // برای slot 0..baseCols-1 از dynamics معمولی استفاده می‌کنیم (ci+slot)
      // برای slot >= baseCols از tupletDynamics
      const dynKey =
        slot < def.baseCols
          ? getCellDynamic(ri, ci + slot)
          : (state.tupletDynamics &&
              state.tupletDynamics[`${ri}-${ci}-${slot}`]) ||
            "";

      if (slotVal && dynKey) {
        const defDyn = DYNAMICS_ALL.find((d) => d.key === dynKey);
        if (defDyn) slotDiv.style.backgroundColor = `var(${defDyn.bgVar})`;
      }
      if (slotVal) slotDiv.classList.add("has-value");

      const inp = document.createElement("input");
      inp.type = "text";
      inp.maxLength = 6;
      inp.value = slotVal;
      inp.dataset.row = ri;
      inp.dataset.col = ci;
      inp.dataset.tupletSlot = slot;

      inp.addEventListener("focus", () => selectRow(ri));

      inp.addEventListener("input", (e) => {
        if (playState && playState.playing) stopPlayback();
        const v = e.target.value.slice(0, 6);
        e.target.value = v;
        if (slot < def.baseCols) {
          state.rows[ri][ci + slot] = v;
        } else {
          if (!state.tripletData) state.tripletData = {};
          state.tripletData[`${ri}-${ci}-${slot}`] = v;
        }
        slotDiv.classList.toggle("has-value", !!v);
        if (!v) {
          slotDiv.style.backgroundColor = "";
          // پاک کردن دینامیک
          if (slot < def.baseCols) {
            if (state.dynamics[ri]) state.dynamics[ri][ci + slot] = "";
          } else {
            if (state.tupletDynamics)
              delete state.tupletDynamics[`${ri}-${ci}-${slot}`];
          }
        }
        markDirty();
        updateStatus();
      });

      // راست‌کلیک / لانگ‌پرس → منوی دینامیک
      const openDynForSlot = (anchorEl) => {
        if (!inp.value.trim()) return;

        if (slot < def.baseCols) {
          const realCi = ci + slot;
          if (
            dynMenuState.ri === ri &&
            dynMenuState.ci === realCi &&
            dynMenuState.tupletSlot === undefined
          ) {
            closeDynamicsMenu();
          } else {
            openDynamicsMenu(ri, realCi, anchorEl);
          }
        } else {
          // برای slot‌های اضافی از یک کلید مصنوعی استفاده می‌کنیم
          if (
            dynMenuState.ri === ri &&
            dynMenuState.ci === ci &&
            dynMenuState.tupletSlot === slot
          ) {
            closeDynamicsMenu();
          } else {
            openTupletSlotDynMenu(ri, ci, slot, anchorEl);
          }
        }
      };
      inp.addEventListener("contextmenu", (e) => {
        if (!inp.value.trim()) return;
        e.preventDefault();
        e.stopPropagation();
        openDynForSlot(inp);
      });

      // موبایل: لانگ پرس (Long Press)
      let longPressTimer = null;
      let longPressFired = false;

      inp.addEventListener(
        "touchstart",
        (e) => {
          if (!inp.value.trim()) return;
          longPressFired = false;

          // ایجاد تایمر ۵۰۰ میلی‌ثانیه‌ای برای تشخیص نگه داشتن انگشت
          longPressTimer = setTimeout(() => {
            longPressFired = true;
            openDynForSlot(inp);
          }, 500);
        },
        { passive: true },
      );

      inp.addEventListener("touchend", () => {
        clearTimeout(longPressTimer);
      });

      inp.addEventListener("touchmove", () => {
        clearTimeout(longPressTimer);
      });

      // موبایل/دسکتاپ: تپ ساده روی خانه‌های تیوپلت دارای متن
      inp.addEventListener("click", (e) => {
        if (longPressFired) {
          // اگر قبلاً با لانگ‌پرس باز شده، کلیک معمولی کاری انجام ندهد
          longPressFired = false;
          return;
        }

        const isMobileDevice = /Mobi|Android|iPhone|iPad/i.test(
          navigator.userAgent,
        );
        if (!isMobileDevice) return;
        if (!inp.value.trim()) return;
        e.stopPropagation(); // بسیار مهم: جلوگیری از بسته شدن آنی منو توسط داکیومنت
        openDynForSlot(inp);
      });

      slotDiv.appendChild(inp);
      wrapper.appendChild(slotDiv);
    }

    cell.appendChild(wrapper);
    rowEl.appendChild(cell);
  }

  // منوی دینامیک برای slot‌های اضافی tuplet (slot >= baseCols)
  function openTupletSlotDynMenu(ri, ci, slot, anchorEl) {
    const menu = document.getElementById("dynamics-menu");
    if (!menu) return;
    // از یک شناسه مصنوعی استفاده می‌کنیم: ri=-1 نشان‌دهنده tuplet extra slot
    dynMenuState = { ri: ri, ci: ci, tupletSlot: slot };
    if (!state.tupletDynamics) state.tupletDynamics = {};
    const current = state.tupletDynamics[`${ri}-${ci}-${slot}`] || "";
    menu.innerHTML = "";

    const rowMain = document.createElement("div");
    rowMain.className = "dyn-menu-row";
    DYNAMICS_MAIN.forEach((def) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dyn-opt" + (current === def.key ? " active" : "");
      btn.style.color = `var(${def.cssVar})`;
      btn.textContent = def.key;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.tupletDynamics) state.tupletDynamics = {};
        state.tupletDynamics[`${ri}-${ci}-${slot}`] = def.key;
        markDirty();
        closeDynamicsMenu();
        render();
      });
      rowMain.appendChild(btn);
    });
    menu.appendChild(rowMain);

    const divider = document.createElement("div");
    divider.className = "dyn-menu-divider";
    menu.appendChild(divider);

    const rowShape = document.createElement("div");
    rowShape.className = "dyn-menu-row";
    DYNAMICS_SHAPE.forEach((def) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dyn-opt" + (current === def.key ? " active" : "");
      btn.style.color = `var(${def.cssVar})`;
      btn.textContent = def.key;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!state.tupletDynamics) state.tupletDynamics = {};
        state.tupletDynamics[`${ri}-${ci}-${slot}`] = def.key;
        markDirty();
        closeDynamicsMenu();
        render();
      });
      rowShape.appendChild(btn);
    });
    menu.appendChild(rowShape);

    const rowReset = document.createElement("div");
    rowReset.className = "dyn-menu-row";
    const resetBtn = document.createElement("button");
    resetBtn.type = "button";
    resetBtn.className = "dyn-opt reset" + (current === "" ? " active" : "");
    resetBtn.textContent = "حالت عادی";
    resetBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.tupletDynamics)
        delete state.tupletDynamics[`${ri}-${ci}-${slot}`];
      markDirty();
      closeDynamicsMenu();
      render();
    });
    rowReset.appendChild(resetBtn);
    menu.appendChild(rowReset);

    menu.classList.add("show");
    const rect = anchorEl.getBoundingClientRect();
    let left = rect.left;
    if (left + 200 > window.innerWidth - 8) left = window.innerWidth - 200 - 8;
    if (left < 8) left = 8;
    let top = rect.bottom + 4;
    if (top + 150 > window.innerHeight - 8) top = rect.top - 150 - 4;
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }
  const sounds = {}; // { filename: AudioBuffer }

  function updateSoundBadge() {
    const badge = document.getElementById("sound-badge");
    const count = Object.keys(sounds).length;
    if (count === 0) {
      badge.textContent = "";
      badge.classList.remove("loaded");
    } else {
      badge.textContent = count;
      badge.classList.add("loaded");
    }
  }

  async function loadSounds() {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/wav,.wav";
    input.multiple = true;
    if (!isMobile && "webkitdirectory" in input) {
      input.webkitdirectory = true;
    }

    input.onchange = async (e) => {
      const files = Array.from(e.target.files).filter((f) =>
        f.name.toLowerCase().endsWith(".wav"),
      );

      if (files.length === 0) {
        toast("هیچ فایل WAV پیدا نشد", true);
        return;
      }

      toast("در حال لود " + files.length + " فایل...");
      const ctx = getAudioCtx();
      let loaded = 0;

      for (const file of files) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          sounds[file.name] = audioBuffer;
          loaded++;
        } catch (err) {
          console.warn("خطا در لود " + file.name, err);
        }
      }

      updateSoundBadge();
      toast(loaded + " فایل WAV با موفقیت لود شد ✓");
      // مودال را رفرش کن و باز نگه‌دار (یا باز کن)
      viewSounds();
    };

    input.click();
  }

  // بارگذاری خودکار سمپل‌ها هنگام باز کردن فایل — دقیقاً مثل loadSounds
  async function autoLoadSoundsForFile(neededNames) {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "audio/wav,.wav";
    input.multiple = true;
    if (!isMobile && "webkitdirectory" in input) {
      input.webkitdirectory = true;
    }

    input.onchange = async (e) => {
      const files = Array.from(e.target.files).filter((f) =>
        f.name.toLowerCase().endsWith(".wav"),
      );
      if (files.length === 0) return toast("هیچ فایل WAV پیدا نشد", true);

      toast("در حال لود " + files.length + " فایل...");
      const ctx = getAudioCtx();
      let loaded = 0;

      for (const file of files) {
        try {
          const arrayBuffer = await file.arrayBuffer();
          const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
          sounds[file.name] = audioBuffer;
          loaded++;
        } catch (err) {
          console.warn("خطا در لود " + file.name, err);
        }
      }

      updateSoundBadge();
      const notFound = neededNames.filter((n) => !sounds[n]);
      if (notFound.length === 0) {
        toast(`همه ${neededNames.length} سمپل با موفقیت لود شدند ✓`);
      } else {
        toast(
          `${loaded} فایل لود شد — ${notFound.length} سمپل هنوز پیدا نشد`,
          true,
        );
      }
    };

    input.click();
  }

  // ══════════════════════════════════════
  // VIEW SOUNDS
  // ══════════════════════════════════════
  let previewSource = null;

  function playSoundPreview(name) {
    const buf = sounds[name];
    if (!buf) return;
    const ctx = getAudioCtx();
    if (previewSource) {
      try {
        previewSource.stop();
      } catch (e) {}
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
    previewSource = src;
  }

  function viewSounds() {
    const list = document.getElementById("sounds-list");
    const empty = document.getElementById("sounds-list-empty");
    const keys = Object.keys(sounds).sort();

    list.innerHTML = "";

    if (keys.length === 0) {
      empty.style.display = "block";
    } else {
      empty.style.display = "none";
      keys.forEach((name) => {
        const buf = sounds[name];
        const dur = buf ? buf.duration.toFixed(2) + "s" : "?";
        const item = document.createElement("div");
        item.className = "sound-item";
        item.innerHTML =
          '<button class="sound-item-play" data-name="' +
          name +
          '" title="پخش">▶</button>' +
          '<span class="sound-item-name" title="' +
          name +
          '">' +
          name +
          "</span>" +
          '<span class="sound-item-dur">' +
          dur +
          "</span>" +
          '<button class="sound-item-del" data-name="' +
          name +
          '">✕</button>';
        item.querySelector(".sound-item-play").onclick = function () {
          playSoundPreview(this.dataset.name);
        };
        item.querySelector(".sound-item-del").onclick = function () {
          delete sounds[this.dataset.name];
          updateSoundBadge();
          viewSounds(); // refresh
        };
        list.appendChild(item);
      });
    }

    document.getElementById("modal-viewsounds").classList.add("show");
  }

  // ══════════════════════════════════════
  // METER → COLS
  // ══════════════════════════════════════
  function meterToCols(meter) {
    const parts = meter.split("/");
    const num = parseInt(parts[0]);
    const den = parseInt(parts[1]);
    if (den === 2) return num * 8;
    if (den === 4) return num * 4;
    if (den === 8 || den === 16) return num * 2;
    return num * 2; // fallback
  }

  // ══════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════
  function render() {
    closeDynamicsMenu();
    const { name, meter, tempo, cols, rows, selected } = state;
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // topbar
    document.getElementById("disp-name").textContent = name || "—";
    document.getElementById("disp-meter").textContent = meter || "—";
    document.getElementById("disp-tempo").textContent = tempo
      ? tempo + " BPM"
      : "—";
    const slider = document.getElementById("tempo-slider");
    if (tempo) {
      slider.value = tempo;
      slider.disabled = false;
      const pct = (((tempo - 40) / (240 - 40)) * 100).toFixed(1) + "%";
      slider.style.setProperty("--val", pct);
    } else {
      slider.disabled = true;
    }
    document.getElementById("disp-rows").textContent = rows.length || "—";

    // selected indicator
    document.getElementById("sel-indicator").textContent =
      selected >= 0 ? `میزان: ${selected + 1}` : "میزان: —";

    // col header
    const header = document.getElementById("col-header");
    header.innerHTML = "";
    const corner = document.createElement("div");
    corner.className = "col-header-corner";
    header.appendChild(corner);

    // beat grouping: every 2 cols = one eighth note (or based on denominator)
    const den = parseInt(meter.split("/")[1] || 4);
    // cols per beat
    const colsPerBeat = den <= 4 ? 4 : den <= 8 ? 2 : 1;

    for (let c = 0; c < cols; c++) {
      const d = document.createElement("div");
      d.className = "col-num" + (c % colsPerBeat === 0 ? " beat-start" : "");
      d.textContent = c + 1;
      header.appendChild(d);
    }

    // grid body
    const body = document.getElementById("grid-body");
    body.innerHTML = "";

    rows.forEach((row, ri) => {
      const rowEl = document.createElement("div");
      rowEl.className = "grid-row";

      // row number (sticky right)
      const numEl = document.createElement("div");
      numEl.className = "row-num" + (ri === selected ? " selected" : "");
      numEl.textContent = ri + 1;
      numEl.title = "کلیک برای منوی عملیات";
      numEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openRowMenu(ri, numEl);
      });
      rowEl.appendChild(numEl);

      // cells
      for (let ci = 0; ci < cols; ci++) {
        // بررسی tuplet
        const tuplet = state.triplets && state.triplets[ri + "-" + ci];
        if (tuplet && tuplet.baseCols) {
          renderTupletCell(ri, ci, tuplet, rowEl, colsPerBeat);
          ci += tuplet.baseCols - 1; // رد کردن سلول‌های پوشش‌داده‌شده
          continue;
        }
        // سلول درون محدوده tuplet (رد می‌شود چون در renderTupletCell رندر شده)
        if (getTupletRole(ri, ci)) continue;

        const cell = document.createElement("div");
        const val = row[ci] || "";
        cell.className =
          "grid-cell" +
          (ci % colsPerBeat === 0 ? " beat-start" : "") +
          (val ? " has-value" : "");

        const inp = document.createElement("input");
        inp.type = "text";
        inp.maxLength = 6;
        inp.value = val;
        inp.dataset.row = ri;
        inp.dataset.col = ci;

        const dynVal = getCellDynamic(ri, ci);
        if (val && dynVal) {
          const def = DYNAMICS_ALL.find((d) => d.key === dynVal);
          if (def) cell.style.backgroundColor = `var(${def.bgVar})`;
        }
        inp.title = val && dynVal ? "نوانس: " + dynVal : "";

        inp.addEventListener("focus", () => selectRow(ri));
        inp.addEventListener("contextmenu", (e) => {
          if (!inp.value.trim()) return;
          e.preventDefault();
          e.stopPropagation();
          openCellContextMenu(ri, ci, inp);
        });

        // long press for mobile (replaces right-click)
        let longPressTimer = null;
        let longPressFired = false;
        inp.addEventListener(
          "touchstart",
          (e) => {
            longPressFired = false;
            longPressTimer = setTimeout(() => {
              if (!inp.value.trim()) return;
              longPressFired = true;
              e.preventDefault();
              openCellContextMenu(ri, ci, inp);
            }, 500);
          },
          { passive: true },
        );
        inp.addEventListener("touchend", () => {
          clearTimeout(longPressTimer);
        });
        inp.addEventListener("touchmove", () => {
          clearTimeout(longPressTimer);
        });

        // در موبایل: تپ ساده روی خانه‌ای که متن دارد
        inp.addEventListener("click", (e) => {
          if (longPressFired) {
            longPressFired = false;
            return;
          }
          if (!isMobile) return;
          if (!inp.value.trim()) return;
          e.stopPropagation();
          openCellContextMenu(ri, ci, inp);
        });

        inp.addEventListener("input", (e) => {
          if (playState && playState.playing) stopPlayback();
          const v = e.target.value.slice(0, 6);
          e.target.value = v;
          state.rows[ri][ci] = v;
          if (!v && state.dynamics[ri]) state.dynamics[ri][ci] = "";
          if (!v) {
            cell.style.backgroundColor = "";
            inp.title = "";
          }
          cell.classList.toggle("has-value", !!v);
          markDirty();
          updateStatus();
        });

        // keyboard nav
        inp.addEventListener("keydown", (e) => {
          const r = parseInt(e.target.dataset.row);
          const c = parseInt(e.target.dataset.col);
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            focusCell(r, c - 1);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            focusCell(r, c + 1);
          } else if (e.key === "ArrowDown" || e.key === "Enter") {
            e.preventDefault();
            focusCell(r + 1, c);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            focusCell(r - 1, c);
          } else if (e.key === "Tab") {
            e.preventDefault();
            if (e.shiftKey) focusCell(r, c - 1);
            else {
              if (c + 1 >= cols) focusCell(r + 1, 0);
              else focusCell(r, c + 1);
            }
          }
        });

        cell.appendChild(inp);
        rowEl.appendChild(cell);
      }

      body.appendChild(rowEl);
    });

    updateStatus();
  }

  function focusCell(r, c) {
    if (r < 0) r = 0;
    if (r >= state.rows.length) r = state.rows.length - 1;
    if (c < 0) c = 0;
    if (c >= state.cols) c = state.cols - 1;
    const inp = document.querySelector(
      `input[data-row="${r}"][data-col="${c}"]`,
    );
    if (inp) {
      inp.focus();
      inp.select();
    }
  }

  function selectRow(ri) {
    state.selected = ri;
    // update row highlights
    document.querySelectorAll(".row-num").forEach((el, i) => {
      el.classList.toggle("selected", i === ri);
    });
    document.getElementById("sel-indicator").textContent = `میزان: ${ri + 1}`;
  }

  // ══════════════════════════════════════
  // ROW CONTEXT MENU (منوی شناور روی شماره میزان)
  // ══════════════════════════════════════
  let _rcmOpen = false;

  function closeRowMenu() {
    const menu = document.getElementById("row-context-menu");
    if (menu) menu.classList.remove("show");
    _rcmOpen = false;
  }

  function openRowMenu(ri, anchorEl) {
    const menu = document.getElementById("row-context-menu");
    if (!menu) return;

    // اگر همین منو برای همین میزان بازه، ببند
    if (_rcmOpen && state.selected === ri) {
      closeRowMenu();
      return;
    }

    selectRow(ri);
    _rcmOpen = true;

    const hasClip = !!state.clipboard;

    menu.innerHTML = `
      <div class="rcm-row">
        <button class="rcm-btn" onclick="app.insertRow(); closeRowContextMenu()" title="درج قبل از این">⊕ قبل</button>
        <button class="rcm-btn" onclick="app.insertRowAfter(); closeRowContextMenu()" title="افزودن بعد از این">↓ بعد</button>
      </div>
      <div class="rcm-divider"></div>
      <div class="rcm-row">
        <button class="rcm-btn" onclick="app.copyRow(); closeRowContextMenu()" title="کپی">⎘ کپی</button>
        <button class="rcm-btn${hasClip ? "" : " disabled"}" style="${hasClip ? "" : "opacity:0.4;cursor:not-allowed"}" onclick="${hasClip ? "app.pasteRow(); closeRowContextMenu()" : ""}" title="پیست (جدید)">⎗ جدید</button>
        <button class="rcm-btn${hasClip ? "" : " disabled"}" style="${hasClip ? "" : "opacity:0.4;cursor:not-allowed"}" onclick="${hasClip ? "app.pasteRowReplace(); closeRowContextMenu()" : ""}" title="پیست (جایگزین)">⇄ جایگزین</button>
      </div>
      <div class="rcm-divider"></div>
      <div class="rcm-row">
        <button class="rcm-btn danger" onclick="app.deleteRow(); closeRowContextMenu()" title="پاک کردن محتوا">⌫ پاک</button>
        <button class="rcm-btn danger" onclick="app.removeRow(); closeRowContextMenu()" title="حذف میزان">✕ حذف</button>
      </div>
      <div class="rcm-divider"></div>
      <div class="rcm-row">
        <button class="rcm-btn play-from-rcm" onclick="app.playFromSelected(); closeRowContextMenu()" title="پخش از اینجا">▶| از اینجا</button>
        <button class="rcm-btn play-only-rcm" onclick="app.playOnlySelected(); closeRowContextMenu()" title="پخش فقط این">▶‖ فقط این</button>
      </div>
    `;

    menu.classList.add("show");

    // موقعیت‌دهی با fixed — همیشه داخل viewport می‌ماند
    const rect = anchorEl.getBoundingClientRect();
    const menuW = 180;
    const menuH = menu.scrollHeight || 320;

    let left = rect.right + 6;
    if (left + menuW > window.innerWidth - 8) {
      left = rect.left - menuW - 6;
    }
    if (left < 8) left = 8;

    let top = rect.top;
    if (top + menuH > window.innerHeight - 8) {
      top = window.innerHeight - menuH - 8;
    }
    if (top < 8) top = 8;

    menu.style.position = "fixed";
    menu.style.left = left + "px";
    menu.style.top = top + "px";
  }

  // expose برای onclick داخل innerHTML
  window.closeRowContextMenu = closeRowMenu;

  document.addEventListener("click", (e) => {
    const menu = document.getElementById("row-context-menu");
    if (!menu || !menu.classList.contains("show")) return;
    if (!menu.contains(e.target) && !e.target.classList.contains("row-num")) {
      closeRowMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeRowMenu();
  });

  function updateStatus() {
    const filled = state.rows.reduce(
      (acc, row) => acc + row.filter((v) => v).length,
      0,
    );
    const total = state.rows.length * state.cols;
    document.getElementById("status-msg").textContent =
      `${state.rows.length} میزان  |  ${state.cols} ستون  |  ${filled} خانه پر از ${total}` +
      (state.dirty ? "  •  ذخیره نشده" : "  ✓  ذخیره شده");
  }

  // ══════════════════════════════════════
  // NEW FILE
  // ══════════════════════════════════════
  function newFile() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    document.getElementById("inp-name").value = "";
    document.getElementById("inp-tempo").value = 85;
    document.getElementById("inp-meter").value = "2/4";
    document.getElementById("inp-initrows").value = 2;
    document.getElementById("inp-savename") &&
      (document.getElementById("inp-savename").value = `Untitled_${dateStr}`);
    document.getElementById("modal-new").classList.add("show");
    setTimeout(() => document.getElementById("inp-name").focus(), 100);
  }

  function cancelNew() {
    document.getElementById("modal-new").classList.remove("show");
  }

  function confirmNew() {
    const name = document.getElementById("inp-name").value.trim() || "Untitled";
    const tempo = parseInt(document.getElementById("inp-tempo").value) || 120;
    const meter = document.getElementById("inp-meter").value;
    const initRows = Math.max(
      1,
      parseInt(document.getElementById("inp-initrows").value) || 16,
    );
    const cols = meterToCols(meter);

    state = {
      name,
      meter,
      tempo,
      cols,
      rows: Array.from({ length: initRows }, () => Array(cols).fill("")),
      dynamics: Array.from({ length: initRows }, () => Array(cols).fill("")),
      triplets: {},
      tripletData: {},
      tupletDynamics: {},
      esharahSettings: {},
      selected: -1,
      clipboard: null,
      clipboardDynamics: null,
      filename: name,
      dirty: false,
    };

    document.getElementById("modal-new").classList.remove("show");
    render();
    persistAutosave();
    toast(`قطعه "${name}" ایجاد شد`);
  }

  // ══════════════════════════════════════
  // ROW OPERATIONS
  // ══════════════════════════════════════
  function insertRow() {
    if (state.rows.length === 0) return toast("ابتدا یک قطعه ایجاد کنید", true);
    const idx = state.selected >= 0 ? state.selected : state.rows.length;
    state.rows.splice(idx, 0, Array(state.cols).fill(""));
    state.dynamics.splice(idx, 0, Array(state.cols).fill(""));
    markDirty();
    render();
    selectRow(idx);
    toast(`میزان ${idx + 1} اضافه شد`);
  }

  function appendRow() {
    if (state.rows.length === 0) return toast("ابتدا یک قطعه ایجاد کنید", true);
    state.rows.push(Array(state.cols).fill(""));
    state.dynamics.push(Array(state.cols).fill(""));
    markDirty();
    render();
    const newIdx = state.rows.length - 1;
    selectRow(newIdx);
    // scroll to bottom
    const gridArea = document.getElementById("grid-area");
    if (gridArea) gridArea.scrollTop = gridArea.scrollHeight;
    toast("میزان " + (newIdx + 1) + " به انتها اضافه شد");
  }

  function insertRowAfter() {
    if (state.rows.length === 0) return toast("ابتدا یک قطعه ایجاد کنید", true);
    const idx = (state.selected >= 0 ? state.selected : state.rows.length - 1) + 1;
    state.rows.splice(idx, 0, Array(state.cols).fill(""));
    state.dynamics.splice(idx, 0, Array(state.cols).fill(""));
    markDirty();
    render();
    selectRow(idx);
    toast("میزان " + (idx + 1) + " بعد از میزان " + idx + " درج شد");
  }

  function deleteRow() {
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    state.rows[state.selected] = Array(state.cols).fill("");
    state.dynamics[state.selected] = Array(state.cols).fill("");
    markDirty();
    render();
    selectRow(state.selected);
    toast(`محتوای میزان ${state.selected + 1} پاک شد`);
  }

  function copyRow() {
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    state.clipboard = [...state.rows[state.selected]];
    state.clipboardDynamics = [
      ...(state.dynamics[state.selected] || Array(state.cols).fill("")),
    ];
    toast(`میزان ${state.selected + 1} کپی شد`);
  }

  function pasteRow() {
    if (!state.clipboard) return toast("چیزی در حافظه نیست", true);
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    const idx = state.selected + 1;
    // adjust clipboard length to current cols
    const adjusted = Array(state.cols)
      .fill("")
      .map((_, i) => state.clipboard[i] || "");
    const adjustedDynamics = Array(state.cols)
      .fill("")
      .map((_, i) => (state.clipboardDynamics || [])[i] || "");
    state.rows.splice(idx, 0, adjusted);
    state.dynamics.splice(idx, 0, adjustedDynamics);
    markDirty();
    render();
    selectRow(idx);
    toast(`میزان paste شد در جایگاه ${idx + 1}`);
  }

  function pasteRowReplace() {
    if (!state.clipboard) return toast("چیزی در حافظه نیست", true);
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    const idx = state.selected;
    // adjust clipboard length to current cols
    const adjusted = Array(state.cols)
      .fill("")
      .map((_, i) => state.clipboard[i] || "");
    const adjustedDynamics = Array(state.cols)
      .fill("")
      .map((_, i) => (state.clipboardDynamics || [])[i] || "");
    state.rows[idx] = adjusted;
    state.dynamics[idx] = adjustedDynamics;
    markDirty();
    render();
    selectRow(idx);
    toast(`محتوای میزان ${idx + 1} با کلیپ‌بورد جایگزین شد`);
  }

  function removeRow() {
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    if (state.rows.length <= 1)
      return toast("حداقل یک میزان باید وجود داشته باشد", true);
    const idx = state.selected;
    state.rows.splice(idx, 1);
    state.dynamics.splice(idx, 1);
    markDirty();
    if (state.selected >= state.rows.length)
      state.selected = state.rows.length - 1;
    render();
    toast(`میزان ${idx + 1} حذف و بقیه جابجا شدند`);
  }

  // ══════════════════════════════════════
  // FILE OPS — TXT FORMAT
  // ══════════════════════════════════════

  // Format:
  // BUSKIT_RHYTHM_FILE
  // name|meter|tempo|cols
  // row data: cell1,cell2,...
  //   هر سلول: متن[~نوانس]   مثال: kick~ff
  // ...

  function serialize() {
    const header = `BUSKIT_RHYTHM_FILE\n${state.name}|${state.meter}|${state.tempo}|${state.cols}\n`;
    const body = state.rows
      .map((row, ri) =>
        row
          .map((val, ci) => {
            const dyn = getCellDynamic(ri, ci);
            return dyn ? `${val}~${dyn}` : val;
          })
          .join(","),
      )
      .join("\n");
    // ذخیره تریوله‌ها
    const tripletPart =
      Object.keys(state.triplets || {}).length > 0
        ? "\nTRIPLETS:" + JSON.stringify(state.triplets)
        : "";
    const tripletDataPart =
      Object.keys(state.tripletData || {}).length > 0
        ? "\nTRIPLET_DATA:" + JSON.stringify(state.tripletData)
        : "";
    const tupletDynPart =
      Object.keys(state.tupletDynamics || {}).length > 0
        ? "\nTUPLET_DYN:" + JSON.stringify(state.tupletDynamics)
        : "";
    const esharahPart =
      Object.keys(state.esharahSettings || {}).length > 0
        ? "\nESHARAH_SETTINGS:" + JSON.stringify(state.esharahSettings)
        : "";
    // ذخیره داده صوتی سمپل‌ها به صورت base64 درون فایل
    // (نام فایل‌ها برای سازگاری با فایل‌های قدیمی هم نگه داشته می‌شود)
    const soundNames = Object.keys(sounds);
    const soundsPart =
      soundNames.length > 0
        ? "\nLOADED_SOUNDS:" + JSON.stringify(soundNames)
        : "";
    // داده صوتی واقعی — به صورت آسنک نمی‌توان در serialize معمولی انجام داد
    // بنابراین serialize فقط metadata می‌سازد؛ برای ذخیره با صدا از saveFileWithSounds استفاده کنید
    return (
      header +
      body +
      tripletPart +
      tripletDataPart +
      tupletDynPart +
      esharahPart +
      soundsPart
    );
  }

  // تبدیل AudioBuffer به base64 WAV
  function audioBufferToBase64(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numSamples = buffer.length;
    const bytesPerSample = 2;
    const dataSize = numSamples * numChannels * bytesPerSample;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++)
        view.setUint8(off + i, s.charCodeAt(i));
    };
    const writeUint32 = (off, v) => view.setUint32(off, v, true);
    const writeUint16 = (off, v) => view.setUint16(off, v, true);
    const writeInt16 = (off, v) => view.setInt16(off, v, true);
    writeStr(0, "RIFF");
    writeUint32(4, 36 + dataSize);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    writeUint32(16, 16);
    writeUint16(20, 1);
    writeUint16(22, numChannels);
    writeUint32(24, sampleRate);
    writeUint32(28, sampleRate * numChannels * bytesPerSample);
    writeUint16(32, numChannels * bytesPerSample);
    writeUint16(34, bytesPerSample * 8);
    writeStr(36, "data");
    writeUint32(40, dataSize);
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const s = buffer.getChannelData(ch)[i];
        const c = Math.max(-1, Math.min(1, s));
        writeInt16(offset, c < 0 ? c * 0x8000 : c * 0x7fff);
        offset += 2;
      }
    }
    // تبدیل به base64
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++)
      binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  // ذخیره فایل همراه با داده صوتی (آسنک) — سمپل‌ها به صورت base64 داخل فایل
  async function saveFileWithSounds() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    let txt = serialize();
    const soundNames = Object.keys(sounds);
    if (soundNames.length > 0) {
      toast(`در حال آماده‌سازی فایل (${soundNames.length} سمپل)...`);
      const soundData = {};
      for (const name of soundNames) {
        try {
          soundData[name] = audioBufferToBase64(sounds[name]);
        } catch (e) {
          console.warn("خطا در encode سمپل " + name, e);
        }
      }
      // حذف LOADED_SOUNDS قدیمی و جایگزینی با SOUND_DATA کامل
      txt = txt.replace(/\nLOADED_SOUNDS:[^\n]*/, "");
      txt += "\nSOUND_DATA:" + JSON.stringify(soundData);
    }
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.filename || state.name) + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
    state.dirty = false;
    updateStatus();
    persistAutosave();
    const soundCount = soundNames.length;
    toast(
      soundCount > 0
        ? `فایل با ${soundCount} سمپل ذخیره شد ✓`
        : "فایل ذخیره شد ✓",
    );
  }

  function deserialize(text) {
    const lines = text.split("\n");
    if (lines[0].trim() !== "BUSKIT_RHYTHM_FILE")
      throw new Error("فرمت فایل نادرست");
    const [name, meter, tempo, cols] = lines[1].split("|");
    const colsNum = parseInt(cols);
    const rows = [];
    const dynamics = [];
    let triplets = {};
    let tripletData = {};
    let tupletDynamics = {};
    let esharahSettings = {};
    let loadedSoundNames = [];
    let soundDataMap = {}; // { filename: base64wav }
    let dataLines = lines.slice(2);
    // جدا کردن بخش تریوله از انتهای فایل
    dataLines = dataLines.filter((l) => {
      if (l.startsWith("TRIPLETS:")) {
        try {
          triplets = JSON.parse(l.slice(9));
        } catch (e) {}
        return false;
      }
      if (l.startsWith("TRIPLET_DATA:")) {
        try {
          tripletData = JSON.parse(l.slice(13));
        } catch (e) {}
        return false;
      }
      if (l.startsWith("TUPLET_DYN:")) {
        try {
          tupletDynamics = JSON.parse(l.slice(11));
        } catch (e) {}
        return false;
      }
      if (l.startsWith("ESHARAH_SETTINGS:")) {
        try {
          esharahSettings = JSON.parse(l.slice(17));
        } catch (e) {}
        return false;
      }
      if (l.startsWith("LOADED_SOUNDS:")) {
        try {
          loadedSoundNames = JSON.parse(l.slice(14));
        } catch (e) {}
        return false;
      }
      if (l.startsWith("SOUND_DATA:")) {
        try {
          soundDataMap = JSON.parse(l.slice(11));
        } catch (e) {}
        return false;
      }
      return true;
    });
    dataLines
      .filter((l) => l.trim())
      .forEach((l) => {
        const cells = l.split(",");
        const rowVals = Array(colsNum).fill("");
        const rowDyns = Array(colsNum).fill("");
        for (let i = 0; i < colsNum; i++) {
          const raw = cells[i] || "";
          const sep = raw.indexOf("~");
          if (sep >= 0) {
            rowVals[i] = raw.slice(0, sep);
            rowDyns[i] = raw.slice(sep + 1);
          } else {
            rowVals[i] = raw;
          }
        }
        rows.push(rowVals);
        dynamics.push(rowDyns);
      });
    return {
      name,
      meter,
      tempo: parseInt(tempo),
      cols: colsNum,
      rows,
      dynamics,
      triplets,
      tripletData,
      tupletDynamics,
      esharahSettings,
      loadedSoundNames,
      soundDataMap,
    };
  }

  function saveFile() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    const txt = serialize();
    const blob = new Blob([txt], { type: "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = (state.filename || state.name) + ".txt";
    a.click();
    URL.revokeObjectURL(a.href);
    state.dirty = false;
    updateStatus();
    persistAutosave();
    toast("فایل ذخیره شد ✓");
  }

  function saveAs() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    document.getElementById("inp-savename").value =
      state.filename || state.name;
    document.getElementById("modal-saveas").classList.add("show");
  }

  function confirmSaveAs() {
    const fname = document.getElementById("inp-savename").value.trim();
    if (!fname) return;
    state.filename = fname;
    document.getElementById("modal-saveas").classList.remove("show");
    saveFileWithSounds();
  }

  function openFile() {
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);

    // input برای فایل txt
    const txtInput = document.createElement("input");
    txtInput.type = "file";
    txtInput.accept = ".txt";

    // input برای سمپل‌ها — از همین user gesture آماده می‌شود
    const wavInput = document.createElement("input");
    wavInput.type = "file";
    wavInput.accept = "audio/wav,.wav";
    wavInput.multiple = true;
    if (!isMobile && "webkitdirectory" in wavInput) {
      wavInput.webkitdirectory = true;
    }

    // وقتی کاربر سمپل‌ها را انتخاب کرد، لود کن
    wavInput.onchange = async (e) => {
      const files = Array.from(e.target.files).filter((f) =>
        f.name.toLowerCase().endsWith(".wav"),
      );
      if (files.length === 0) return;
      toast("در حال لود " + files.length + " سمپل...");
      const ctx = getAudioCtx();
      let loaded = 0;
      for (const f of files) {
        try {
          const ab = await f.arrayBuffer();
          const buf = await ctx.decodeAudioData(ab);
          sounds[f.name] = buf;
          loaded++;
        } catch (err) {
          console.warn("خطا در لود " + f.name, err);
        }
      }
      updateSoundBadge();
      toast(loaded + " سمپل بارگذاری شد ✓");
    };

    txtInput.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const parsed = deserialize(ev.target.result);
          state = {
            ...parsed,
            esharahSettings: parsed.esharahSettings || {},
            selected: -1,
            clipboard: null,
            clipboardDynamics: null,
            filename: file.name.replace(".txt", ""),
            dirty: false,
          };
          render();
          persistAutosave();
          toast(`"${state.name}" باز شد`);

          // اگر فایل حاوی داده صوتی base64 است، مستقیم decode کن (نیازی به لود مجدد نیست)
          const soundDataMap = parsed.soundDataMap || {};
          if (Object.keys(soundDataMap).length > 0) {
            toast("در حال بارگذاری سمپل‌های داخل فایل...");
            const ctx = getAudioCtx();
            let loaded = 0;
            for (const [name, b64] of Object.entries(soundDataMap)) {
              try {
                // base64 → ArrayBuffer
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++)
                  bytes[i] = binary.charCodeAt(i);
                const audioBuffer = await ctx.decodeAudioData(bytes.buffer);
                sounds[name] = audioBuffer;
                loaded++;
              } catch (err) {
                console.warn("خطا در decode سمپل " + name, err);
              }
            }
            updateSoundBadge();
            toast(`${loaded} سمپل از فایل بارگذاری شد ✓`);
            return; // نیازی به لود خارجی نیست
          }

          // اگر SOUND_DATA نداشت، سمپل‌های خارجی را بخواه
          const neededSounds = parsed.loadedSoundNames || [];
          if (neededSounds.length > 0) {
            const missing = neededSounds.filter((n) => !sounds[n]);
            if (missing.length > 0) {
              const dirName = parsed.samplesDirName || "";
              autoLoadSoundsForFile(neededSounds, dirName);
            }
          }
        } catch (err) {
          toast("خطا در باز کردن فایل: " + err.message, true);
        }
      };
      reader.readAsText(file);
    };

    txtInput.click();
  }

  // ══════════════════════════════════════
  // TOAST
  // ══════════════════════════════════════
  let toastTimer;
  function toast(msg, isError = false) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.className = "show" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = "";
    }, 2500);
  }

  // ══════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ══════════════════════════════════════
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "s") {
        e.preventDefault();
        saveFileWithSounds();
      } else if (e.key === "n") {
        e.preventDefault();
        newFile();
      } else if (e.key === "o") {
        e.preventDefault();
        openFile();
      } else if (e.key === "c" && document.activeElement.tagName !== "INPUT") {
        e.preventDefault();
        copyRow();
      } else if (e.key === "v" && document.activeElement.tagName !== "INPUT") {
        e.preventDefault();
        pasteRow();
      }
    }
  });

  // ══════════════════════════════════════
  // INIT — show empty state
  // ══════════════════════════════════════
  render();
  checkAutosaveOnLoad();

  function changeTempo(val) {
    if (!state.name) return;
    val = parseInt(val);
    state.tempo = val;
    markDirty();
    document.getElementById("disp-tempo").textContent = val + " BPM";
    const pct = (((val - 40) / (240 - 40)) * 100).toFixed(1) + "%";
    document.getElementById("tempo-slider").style.setProperty("--val", pct);
    updateStatus();
  }

  // ══════════════════════════════════════
  // TEMPO MODAL — تنظیم دقیق تمپو در موبایل
  // ══════════════════════════════════════
  // همان مرز عرضی که در style.css برای حالت موبایل استفاده شده (700px)
  function isMobileLayout() {
    return window.innerWidth <= 700;
  }

  function openTempoModal() {
    if (!state.name) return;
    document.getElementById("inp-tempo-modal").value = state.tempo;
    document.getElementById("modal-tempo").classList.add("show");
    setTimeout(() => document.getElementById("inp-tempo-modal").focus(), 100);
  }

  function cancelTempoModal() {
    document.getElementById("modal-tempo").classList.remove("show");
  }

  function confirmTempoModal() {
    const raw = document.getElementById("inp-tempo-modal").value;
    let val = parseInt(raw);
    if (isNaN(val)) return toast("مقدار تمپو نامعتبر است", true);
    val = Math.max(40, Math.min(240, val));
    document.getElementById("modal-tempo").classList.remove("show");
    document.getElementById("tempo-slider").value = val;
    changeTempo(val);
  }

  // ══════════════════════════════════════
  // AUDIO ENGINE
  // ══════════════════════════════════════
  let audioCtx = null;
  let playState = {
    playing: false,
    loop: false,
    longLoop: false,
    longLoopEndTime: 0, // absolute audioCtx time when long loop should stop
    startTime: 0, // audioCtx.currentTime when playback started
    totalDur: 0, // total duration in seconds
    rafId: null, // requestAnimationFrame id
    scheduledNodes: [], // all BufferSourceNodes so we can stop them
  };

  // فایل طولانیِ از‌پیش‌رندرشده‌ی Long Loop، برای استفاده مجدد توسط دکمه WAV
  let longLoopBuffer = null;
  let longLoopSignature = null;
  let longLoopRendering = false;

  function getAudioCtx() {
    if (!audioCtx)
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  // resolve "D" → sounds["D.wav"] or sounds["D.WAV"] etc.
  // اگر symbol مثل "o_D" بود (اشاره)، بخش بعد از _ را جدا کرده و resolve می‌کند
  function resolveSound(symbol) {
    if (!symbol || symbol === "-") return null;

    // اگر symbol شامل _ است (مثل o_D یا )_T)، بخش اصلی بعد از آخرین _ را بگیر
    let effectiveSymbol = symbol;
    const underscoreIdx = symbol.indexOf("_");
    if (underscoreIdx !== -1 && underscoreIdx < symbol.length - 1) {
      // مثال: "o_D" → "D" ، ")_T" → "T"
      effectiveSymbol = symbol.slice(underscoreIdx + 1);
    }

    const keys = Object.keys(sounds);
    // exact match with .wav
    const exact = keys.find(
      (k) => k.toLowerCase() === effectiveSymbol.toLowerCase() + ".wav",
    );
    if (exact) return sounds[exact];
    // fallback: starts with symbol (case-insensitive)
    const partial = keys.find((k) =>
      k.toLowerCase().startsWith(effectiveSymbol.toLowerCase() + "."),
    );
    if (partial) return sounds[partial];
    return null;
  }

  // build a flat list of {symbol, startSec, durationSec} events from current state
  // build a flat list of {symbol, startSec, durationSec} events from current state
  function buildTimeline() {
    const { rows, cols, tempo, meter, triplets } = state;
    if (rows.length === 0) return { events: [], totalDur: 0 };

    const parts = meter.split("/");
    const den = parseInt(parts[1] || "4");
    const subdivsPerBeat = den <= 4 ? 4 : 2;
    const cellDur = 60 / tempo / subdivsPerBeat;

    let events = [];
    let t = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      let ci = 0;
      while (ci < cols) {
        const tuplet = triplets ? triplets[ri + "-" + ci] : null;
        if (tuplet && tuplet.baseCols) {
          const def = TUPLET_TYPES[tuplet.type];
          if (def) {
            const totalDur = tuplet.baseCols * cellDur;
            const noteDur = totalDur / tuplet.slots;
            for (let slot = 0; slot < tuplet.slots; slot++) {
              let sym = "";
              if (slot < tuplet.baseCols) {
                sym = row[ci + slot] || "";
              } else {
                sym =
                  (state.tripletData &&
                    state.tripletData[`${ri}-${ci}-${slot}`]) ||
                  "";
              }
              sym = sym.trim();
              if (sym && sym !== "-") {
                const dyn =
                  slot < tuplet.baseCols
                    ? getCellDynamic(ri, ci + slot)
                    : (state.tupletDynamics &&
                        state.tupletDynamics[`${ri}-${ci}-${slot}`]) ||
                      "";
                events.push({
                  symbol: sym,
                  row: ri,
                  startSec: t + slot * noteDur,
                  durationSec: noteDur,
                  dynamic: dyn,
                  isTuplet: true,
                });
              }
            }
          }
          t += cellDur * tuplet.baseCols;
          ci += tuplet.baseCols;
          continue;
        }

        if (getTupletRole(ri, ci) && !(triplets && triplets[ri + "-" + ci])) {
          ci++;
          t += cellDur;
          continue;
        }

        const sym = row[ci] ? row[ci].trim() : "";
        if (!sym || sym === "-") {
          ci++;
          t += cellDur;
          continue;
        }

        let dur = cellDur;
        let next = ci + 1;
        while (next < cols && row[next] && row[next].trim() === "-") {
          dur += cellDur;
          next++;
        }

        events.push({
          symbol: sym,
          row: ri,
          startSec: t,
          durationSec: dur,
          dynamic: getCellDynamic(ri, ci),
        });
        t += dur;
        ci = next;
      }
    }

    // ──────────────────────────────────────────────────────────────
    // ⚡ بخش جدید: پردازش و اضافه کردن تکنیک‌های اشاره قبل از نت اصلی
    // ──────────────────────────────────────────────────────────────
    let finalEvents = [];
    const totalEsharahSec = ESHARAH_TOTAL_DURATION / 1000; // تبدیل ۵۰ میلی ثانیه به ثانیه (0.05)
    const singleTechSec = totalEsharahSec / 2; // زمان هر زیرتکنیک اشاره (0.025)

    events.forEach((ev) => {
      // بررسی اینکه آیا این تکنیک اشاره دارد یا نه
      // ev.symbol مثل "o_D" است — باید پیدا کنیم کدام کلید اشاره (مثل "o_") با این شروع می‌شود
      let esharahConfig = null;
      let esharahKey = null;
      if (state.esharahSettings) {
        for (const key of Object.keys(state.esharahSettings)) {
          if (ev.symbol.startsWith(key)) {
            esharahConfig = state.esharahSettings[key];
            esharahKey = key;
            break;
          }
        }
      }

      if (esharahConfig) {
        // ۱. اضافه کردن تکنیک اول اشاره
        // زمان نسبی — ممکن است منفی باشد (برای اولین نت یا اول لوپ)
        // scheduleOnce این را با totalDur قبلی جبران می‌کند
        if (esharahConfig.sel1) {
          finalEvents.push({
            symbol: esharahConfig.sel1,
            row: ev.row,
            startSec: ev.startSec - totalEsharahSec, // می‌تواند منفی باشد
            durationSec: singleTechSec,
            dynamic: "p",
            isEsharah: true,
          });
        }

        // ۲. اضافه کردن تکنیک دوم اشاره
        if (esharahConfig.sel2 && esharahConfig.sel2 !== "") {
          finalEvents.push({
            symbol: esharahConfig.sel2,
            row: ev.row,
            startSec: ev.startSec - singleTechSec, // می‌تواند منفی باشد
            durationSec: singleTechSec,
            dynamic: "p",
            isEsharah: true,
          });
        }
      }

      // ۳. خود تکنیک اصلی بدون دستخوش تغییر در زمان اصلی خودش اضافه می‌شود
      finalEvents.push(ev);
    });

    // مرتب‌سازی مجدد رویدادها بر اساس زمان صعودی
    finalEvents.sort((a, b) => a.startSec - b.startSec);

    return { events: finalEvents, totalDur: t };
  }
  // اعمال حجم بر اساس نوانس (ff..pp) یا شکل قوسی (< > <>) روی یک gainNode
  // absStart: زمان مطلق شروع نت در AudioContext/OfflineAudioContext
  // bufDur: طول کامل فایل صوتی منبع
  // ctx: AudioContext (یا OfflineAudioContext) — برای گرفتن currentTime
  function applyNoteGain(gainNode, ev, absStart, bufDur, ctx) {
    const dyn = ev.dynamic || "";
    const playDur = ev.durationSec;
    const trim = bufDur > playDur;
    const span = trim ? playDur : bufDur;
    const fadeOutDur = trim
      ? Math.min(0.08, playDur * 0.2)
      : Math.min(0.05, bufDur * 0.25);
    const shapeSpan = Math.max(0.001, span - fadeOutDur);
    const fadeEndVal = trim ? 0 : 0.001;

    // 1. پاک کردن زمان‌بندی‌های قبلی از لحظه شروع همین نت
    gainNode.gain.cancelScheduledValues(absStart);

    // 2. تنظیم ولوم روی صفر دقیقاً در لحظه شروع نت (به جای currentTime مرورگر)
    gainNode.gain.setValueAtTime(0, absStart);

    if (isShapeDynamic(dyn)) {
      const peak = DYNAMIC_GAIN.mf;
      const lo = peak * SHAPE_LOW_RATIO;
      if (dyn === "<") {
        gainNode.gain.setValueAtTime(lo, absStart);
        gainNode.gain.linearRampToValueAtTime(peak, absStart + shapeSpan);
      } else if (dyn === ">") {
        gainNode.gain.setValueAtTime(peak, absStart);
        gainNode.gain.linearRampToValueAtTime(lo, absStart + shapeSpan);
      } else {
        gainNode.gain.setValueAtTime(lo, absStart);
        gainNode.gain.linearRampToValueAtTime(peak, absStart + shapeSpan / 2);
        gainNode.gain.linearRampToValueAtTime(lo, absStart + shapeSpan);
      }
    } else {
      // نوانس‌های عادی (ff, f, mf, p, pp)
      const volume = DYNAMIC_GAIN[dyn] !== undefined ? DYNAMIC_GAIN[dyn] : 0.75;
      // ولوم نت را در زمان شروع خودش به مقدار واقعی می‌رسانیم
      gainNode.gain.setValueAtTime(volume, absStart);
    }

    // اعمال فید اوت (Fade out) در انتهای نت برای جلوگیری از صدای تق‌تق یا دیستورت
    gainNode.gain.setValueAtTime(gainNode.gain.value, absStart + shapeSpan);
    gainNode.gain.linearRampToValueAtTime(fadeEndVal, absStart + span);
  }
  // پخش از یک میزان خاص تا آخر (onlyOne=false) یا فقط همان میزان (onlyOne=true)
  function schedulePlaybackFrom(startRow, onlyOne) {
    const ctx = getAudioCtx();
    const { events, totalDur } = buildTimeline();
    if (totalDur === 0) {
      toast("گریدی وجود ندارد", true);
      return;
    }

    // محاسبه زمان شروع و پایان میزان انتخاب‌شده
    const { cols, tempo, meter } = state;
    const den = parseInt(meter.split("/")[1] || "4");
    const subdivsPerBeat = den <= 4 ? 4 : 2;
    const cellDur = 60 / tempo / subdivsPerBeat;
    const rowDur = cols * cellDur;

    const fromSec = startRow * rowDur;
    const toSec = onlyOne ? fromSec + rowDur : totalDur;
    const playDur = toSec - fromSec;

    // فیلتر رویدادها:
    // رویدادهای اشاره (isEsharah) ممکن است startSec منفی داشته باشند —
    // آن‌ها را بر اساس row میزان اصلی‌شان فیلتر می‌کنیم
    const filteredEvents = events.filter((ev) => {
      if (ev.isEsharah) {
        // اشاره را فقط اگر row اصلی‌اش در بازه باشد نگه می‌داریم
        return ev.row >= startRow && (onlyOne ? ev.row === startRow : true);
      }
      // رویداد معمولی: startSec باید در بازه [fromSec, toSec) باشد
      return ev.startSec >= fromSec - 0.0001 && ev.startSec < toSec - 0.0001;
    });

    playState.playing = true;
    playState.loop = false;
    playState.longLoop = false;
    playState.startTime = ctx.currentTime;
    playState.totalDur = playDur;
    playState.scheduledNodes = [];

    filteredEvents.forEach((ev) => {
      const buf = resolveSound(ev.symbol);
      if (!buf) return;

      // زمان نسبی رویداد نسبت به fromSec
      // برای اشاره‌هایی که startSec واقعی‌شان قبل از fromSec است،
      // آن‌ها را از ابتدای پخش می‌گذاریم (زمان ۰)
      const relStart = Math.max(0, ev.startSec - fromSec);
      const absStart = ctx.currentTime + relStart;

      const src = ctx.createBufferSource();
      const gainNode = ctx.createGain();
      const noteDur = ev.durationSec;
      const bufDur = buf.duration;

      applyNoteGain(gainNode, ev, absStart, bufDur, ctx);
      src.buffer = buf;
      src.connect(gainNode);
      gainNode.connect(ctx.destination);
      src.start(absStart);
      if (bufDur > noteDur) {
        src.stop(absStart + noteDur + 0.01);
      }
      playState.scheduledNodes.push(src);
    });

    startProgressUIFrom(playDur, fromSec);
    setTimeout(() => stopPlayback(), playDur * 1000 + 150);
    updatePlayFromButtons(onlyOne);
  }

  function startProgressUIFrom(totalDurSec, rowOffsetSec) {
    const startTime = audioCtx.currentTime;

    function tick() {
      if (!playState.playing) return;
      const elapsed = audioCtx.currentTime - startTime;
      const pos = Math.min(elapsed, totalDurSec);
      const pct = (pos / totalDurSec) * 100;
      document.getElementById("play-progress").style.width = pct + "%";

      const secs = Math.floor(pos);
      const ms = Math.floor((pos - secs) * 10);
      document.getElementById("play-time").textContent =
        Math.floor(secs / 60) +
        ":" +
        String(secs % 60).padStart(2, "0") +
        "." +
        ms;

      // هایلایت ردیف در حال پخش
      const { cols, tempo, meter } = state;
      const den = parseInt(meter.split("/")[1] || "4");
      const subdivsPerBeat = den <= 4 ? 4 : 2;
      const cellDur = 60 / tempo / subdivsPerBeat;
      const rowDur = cols * cellDur;
      const currentRow = Math.floor((rowOffsetSec + pos) / rowDur);
      document.querySelectorAll(".grid-row").forEach((el, i) => {
        el.classList.toggle("playing-row", i === currentRow);
      });

      playState.rafId = requestAnimationFrame(tick);
    }
    playState.rafId = requestAnimationFrame(tick);
  }

  function updatePlayFromButtons(onlyOne) {
    const fromBtn = document.getElementById("btn-play-from");
    const onlyBtn = document.getElementById("btn-play-only");
    if (!fromBtn || !onlyBtn) return;

    if (playState.playing && !onlyOne) {
      fromBtn.textContent = "⏸ Play from";
      fromBtn.classList.add("playing");
    } else {
      fromBtn.textContent = "▶| Play from";
      fromBtn.classList.remove("playing");
    }
    if (playState.playing && onlyOne) {
      onlyBtn.textContent = "⏸ Play only";
      onlyBtn.classList.add("playing");
    } else {
      onlyBtn.textContent = "▶‖ Play only";
      onlyBtn.classList.remove("playing");
    }
  }

  function schedulePlayback(loop) {
    const ctx = getAudioCtx();
    const { events, totalDur } = buildTimeline();
    if (totalDur === 0) {
      toast("گریدی وجود ندارد", true);
      return;
    }

    playState.playing = true;
    playState.loop = loop;
    playState.startTime = ctx.currentTime;
    playState.totalDur = totalDur;
    playState.scheduledNodes = [];

    function scheduleOnce(offset, prevOffset) {
      events.forEach((ev) => {
        const buf = resolveSound(ev.symbol);
        if (!buf) return;

        let absStart;
        if (ev.isEsharah && ev.startSec < 0) {
          // اشاره‌ای که زمانش منفی است باید از انتهای لوپ قبلی پخش شود
          if (prevOffset === undefined) {
            // اولین پخش — اشاره‌ی منفی را از همان offset می‌گذاریم
            // (در بدترین حالت با نت اصلی همزمان می‌شود، که بهتر از نپخشیدن است)
            absStart = offset + Math.max(0, ev.startSec);
          } else {
            absStart = prevOffset + totalDur + ev.startSec;
          }
        } else {
          absStart = offset + ev.startSec;
        }

        // اگر زمان پخش گذشته، رد کن
        if (absStart < ctx.currentTime - 0.01) return;

        const src = ctx.createBufferSource();
        const gainNode = ctx.createGain();
        const playDur = ev.durationSec;
        const bufDur = buf.duration;

        applyNoteGain(gainNode, ev, absStart, bufDur, ctx);
        src.buffer = buf;
        src.connect(gainNode);
        gainNode.connect(ctx.destination);
        src.start(absStart);
        if (bufDur > playDur) {
          src.stop(absStart + playDur + 0.01);
        }

        playState.scheduledNodes.push(src);
      });
    }

    scheduleOnce(ctx.currentTime, undefined);

    // if loop, schedule next repetition slightly before end
    if (loop) {
      let lastScheduledOffset = ctx.currentTime;
      function scheduleLoop() {
        if (!playState.playing || !playState.loop) return;
        const elapsed = ctx.currentTime - playState.startTime;
        const loopsCompleted = Math.floor(elapsed / totalDur);
        const nextStart = playState.startTime + (loopsCompleted + 1) * totalDur;
        // if long loop, stop scheduling once we'd exceed the end time
        if (playState.longLoop && nextStart >= playState.longLoopEndTime) {
          // schedule stop after last loop completes
          const stopAt = playState.longLoopEndTime - playState.startTime;
          setTimeout(
            () => stopPlayback(),
            Math.max(
              0,
              stopAt * 1000 - (ctx.currentTime - playState.startTime) * 1000,
            ),
          );
          return;
        }
        // schedule 0.3s ahead
        if (nextStart - ctx.currentTime < 0.5) {
          const prevOff = nextStart - totalDur;
          scheduleOnce(nextStart, prevOff);
          lastScheduledOffset = nextStart;
        }
        setTimeout(scheduleLoop, 150);
      }
      setTimeout(scheduleLoop, Math.max(0, (totalDur - 0.5) * 1000));
    } else {
      // auto stop after totalDur
      setTimeout(() => stopPlayback(), totalDur * 1000 + 100);
    }

    startProgressUI(totalDur, loop);
    updatePlayButtons();
  }

  function stopPlayback() {
    playState.playing = false;
    playState.loop = false;
    playState.longLoop = false;
    playState.longLoopEndTime = 0;
    // hide long loop timer
    const timerEl = document.getElementById("long-loop-timer");
    if (timerEl) timerEl.classList.add("hidden");
    playState.scheduledNodes.forEach((n) => {
      try {
        n.stop();
      } catch (e) {}
    });
    playState.scheduledNodes = [];
    cancelAnimationFrame(playState.rafId);
    document.getElementById("play-progress").style.width = "0%";
    document.getElementById("play-time").textContent = "0:00";
    document
      .querySelectorAll(".grid-row.playing-row")
      .forEach((r) => r.classList.remove("playing-row"));
    updatePlayButtons();
    updatePlayFromButtons(false);
    updatePlayFromButtons(true);
  }

  function startProgressUI(totalDur, loop) {
    const startTime = audioCtx.currentTime;

    function tick() {
      if (!playState.playing) return;
      const elapsed = audioCtx.currentTime - startTime;
      const pos = loop ? elapsed % totalDur : Math.min(elapsed, totalDur);
      const pct = (pos / totalDur) * 100;
      document.getElementById("play-progress").style.width = pct + "%";

      // time display
      const secs = Math.floor(pos);
      const ms = Math.floor((pos - secs) * 10);
      document.getElementById("play-time").textContent =
        Math.floor(secs / 60) +
        ":" +
        String(secs % 60).padStart(2, "0") +
        "." +
        ms;

      // highlight current row
      const { rows, cols, tempo, meter } = state;
      const den = parseInt(meter.split("/")[1] || 4);
      const subdivsPerBeat = den <= 4 ? 4 : 2;
      const cellDur = 60 / tempo / subdivsPerBeat;
      const rowDur = cols * cellDur;
      const currentRow = Math.floor(pos / rowDur);
      document.querySelectorAll(".grid-row").forEach((el, i) => {
        el.classList.toggle("playing-row", i === currentRow);
      });

      playState.rafId = requestAnimationFrame(tick);
    }
    playState.rafId = requestAnimationFrame(tick);
  }

  function updatePlayButtons() {
    const once = document.getElementById("btn-play-once");
    const loop = document.getElementById("btn-play-loop");
    const longLoop = document.getElementById("btn-play-long-loop");
    if (playState.playing && !playState.loop) {
      once.textContent = "⏸ Pause";
      once.classList.add("playing");
    } else {
      once.textContent = "▶ Play";
      once.classList.remove("playing");
    }
    if (playState.playing && playState.loop && !playState.longLoop) {
      loop.textContent = "⏸ Loop";
      loop.classList.add("playing");
    } else {
      loop.textContent = "⟳ Loop";
      loop.classList.remove("playing");
    }
    if (playState.playing && playState.longLoop) {
      longLoop.textContent = "⏸ Long Loop";
      longLoop.classList.add("playing");
    } else {
      longLoop.textContent = "⏱ Long Loop";
      longLoop.classList.remove("playing");
    }
  }

  function playOnce() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (playState.playing) {
      stopPlayback();
      return;
    }
    schedulePlayback(false);
  }

  function playLoop() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (playState.playing) {
      stopPlayback();
      return;
    }
    schedulePlayback(true);
  }

  function playFromSelected() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    if (playState.playing) {
      stopPlayback();
      return;
    }
    schedulePlaybackFrom(state.selected, false);
  }

  function playOnlySelected() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (state.selected < 0) return toast("ابتدا یک میزان انتخاب کنید", true);
    if (playState.playing) {
      stopPlayback();
      return;
    }
    schedulePlaybackFrom(state.selected, true);
  }

  // امضایی از وضعیت فعلی قطعه (برای تشخیص اینکه فایل طولانیِ کش‌شده هنوز معتبر است یا نه)
  function getTimelineSignature() {
    return JSON.stringify({
      rows: state.rows,
      dynamics: state.dynamics,
      tempo: state.tempo,
      meter: state.meter,
      sounds: Object.keys(sounds).sort(),
    });
  }

  // قطعه را پشت‌سرهم کپی می‌کند تا یک بافر صوتی به طول durationSecs بسازد
  async function renderLongLoopBuffer(durationSecs) {
    const { events, totalDur } = buildTimeline();
    if (totalDur === 0) throw new Error("گریدی وجود ندارد");

    const ctx = getAudioCtx();
    const sampleRate = ctx.sampleRate;
    const totalSamples = Math.ceil(durationSecs * sampleRate);
    const offline = new OfflineAudioContext(2, totalSamples, sampleRate);

    let loopStart = 0;
    while (loopStart < durationSecs) {
      for (const ev of events) {
        const absStart = loopStart + ev.startSec;
        if (absStart >= durationSecs) continue;

        const buf = resolveSound(ev.symbol);
        if (!buf) continue;

        const src = offline.createBufferSource();
        const gainNode = offline.createGain();
        src.buffer = buf;

        const playDur = ev.durationSec;
        const bufDur = buf.duration;

        applyNoteGain(gainNode, ev, absStart, bufDur, offline);
        src.connect(gainNode);
        gainNode.connect(offline.destination);
        src.start(absStart);
        if (bufDur > playDur) {
          src.stop(absStart + playDur + 0.01);
        }
      }
      loopStart += totalDur;
    }

    const renderedBuffer = await offline.startRendering();
    return { buffer: renderedBuffer, loopDur: totalDur };
  }

  function playLongLoop() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (playState.playing) {
      stopPlayback();
      return;
    }
    document.getElementById("modal-longloop").classList.add("show");
    setTimeout(
      () => document.getElementById("inp-longloop-minutes").focus(),
      100,
    );
  }

  async function confirmLongLoop() {
    if (longLoopRendering) return;
    const minutes =
      parseFloat(document.getElementById("inp-longloop-minutes").value) || 5;
    document.getElementById("modal-longloop").classList.remove("show");
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (Object.keys(sounds).length === 0)
      return toast("ابتدا فایل‌های WAV را لود کنید", true);

    if (playState.playing) stopPlayback();

    const durationSecs = minutes * 60;
    longLoopRendering = true;
    toast("⏳ در حال ساخت فایل طولانی...");

    try {
      const { buffer: renderedBuffer, loopDur } =
        await renderLongLoopBuffer(durationSecs);

      // کش کردن فایل ساخته‌شده، تا دکمه WAV همین فایل کامل را ذخیره کند
      longLoopBuffer = renderedBuffer;
      longLoopSignature = getTimelineSignature();

      toast("✓ فایل شما ساخته شد");

      const ctx = getAudioCtx();
      const src = ctx.createBufferSource();
      src.buffer = renderedBuffer;
      src.connect(ctx.destination);

      playState.playing = true;
      playState.loop = true;
      playState.longLoop = true;
      playState.startTime = ctx.currentTime;
      playState.totalDur = loopDur;
      playState.longLoopEndTime = ctx.currentTime + renderedBuffer.duration;
      playState.scheduledNodes = [src];

      src.onended = () => {
        if (playState.playing && playState.longLoop) stopPlayback();
      };
      src.start(0);

      startProgressUI(loopDur, true);
      updatePlayButtons();
      startLongLoopTimer(renderedBuffer.duration);
    } catch (err) {
      toast("خطا در ساخت فایل طولانی: " + err.message, true);
      console.error(err);
    } finally {
      longLoopRendering = false;
    }
  }

  function startLongLoopTimer(totalSecs) {
    const timerEl = document.getElementById("long-loop-timer");
    const textEl = document.getElementById("llt-text");
    const arc = document.getElementById("llt-arc");
    const CIRCUM = 100;

    timerEl.classList.remove("hidden");

    const wallStart = performance.now(); // ms

    function fmt(secs) {
      const m = Math.floor(secs / 60);
      const s = Math.floor(secs % 60);
      return m + ":" + String(s).padStart(2, "0");
    }

    function tickTimer() {
      if (!playState.playing || !playState.longLoop) {
        timerEl.classList.add("hidden");
        return;
      }
      const elapsed = (performance.now() - wallStart) / 1000;
      const clamped = Math.min(elapsed, totalSecs);
      const progress = clamped / totalSecs; // 0→1

      // ring fills up as time passes
      arc.style.strokeDashoffset = ((1 - progress) * CIRCUM).toFixed(2);

      // colour shift when < 30s left
      const remaining = totalSecs - clamped;
      const ending = remaining < 30;
      arc.classList.toggle("ending", ending);
      textEl.classList.toggle("ending", ending);

      // show elapsed / total
      textEl.textContent = fmt(clamped) + " / " + fmt(totalSecs);

      if (clamped < totalSecs) {
        requestAnimationFrame(tickTimer);
      } else {
        timerEl.classList.add("hidden");
      }
    }
    requestAnimationFrame(tickTimer);
  }

  // ══════════════════════════════════════
  // SAVE WAV
  // ══════════════════════════════════════
  function saveWav() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    if (Object.keys(sounds).length === 0)
      return toast("ابتدا فایل‌های WAV را لود کنید", true);
    const defaultName = (state.filename || state.name || "rhythm").replace(
      /[^a-zA-Z0-9_-]/g,
      "_",
    );
    document.getElementById("inp-wavname").value = defaultName;
    document.getElementById("modal-savewav").classList.add("show");
    setTimeout(() => document.getElementById("inp-wavname").focus(), 100);
  }

  async function confirmSaveWav() {
    const fname =
      document.getElementById("inp-wavname").value.trim() || "rhythm";
    document.getElementById("modal-savewav").classList.remove("show");

    // اگر یک فایل طولانیِ Long Loop مطابق با وضعیت فعلی قطعه از قبل ساخته شده،
    // همان فایل کامل (به طول درخواست‌شده) ذخیره شود
    if (longLoopBuffer && longLoopSignature === getTimelineSignature()) {
      toast("در حال رندر WAV (فایل طولانی)...");
      try {
        const wavBlob = audioBufferToWav(longLoopBuffer);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = fname + ".wav";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        toast("فایل " + fname + ".wav (فایل طولانی) دانلود شد ✓");
      } catch (err) {
        toast("خطا در رندر: " + err.message, true);
        console.error(err);
      }
      return;
    }

    toast("در حال رندر WAV...");

    try {
      const { events, totalDur } = buildTimeline();
      if (totalDur === 0) return toast("گریدی وجود ندارد", true);

      const ctx = getAudioCtx();
      const sampleRate = ctx.sampleRate;
      const totalSamples = Math.ceil(totalDur * sampleRate) + sampleRate; // +1s tail
      const offline = new OfflineAudioContext(2, totalSamples, sampleRate);

      for (const ev of events) {
        const buf = resolveSound(ev.symbol);
        if (!buf) continue;

        const src = offline.createBufferSource();
        const gainNode = offline.createGain();
        src.buffer = buf;

        const playDur = ev.durationSec;
        const bufDur = buf.duration;

        applyNoteGain(gainNode, ev, ev.startSec, bufDur, offline);
        src.connect(gainNode);
        gainNode.connect(offline.destination);
        src.start(ev.startSec);
        if (bufDur > playDur) {
          src.stop(ev.startSec + playDur + 0.01);
        }
      }

      const renderedBuffer = await offline.startRendering();
      const wavBlob = audioBufferToWav(renderedBuffer);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname + ".wav";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast("فایل " + fname + ".wav دانلود شد ✓");
    } catch (err) {
      toast("خطا در رندر: " + err.message, true);
      console.error(err);
    }
  }

  // Convert AudioBuffer to WAV Blob
  function audioBufferToWav(buffer) {
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const numSamples = buffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;
    const arrayBuffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(arrayBuffer);

    function writeStr(offset, str) {
      for (let i = 0; i < str.length; i++)
        view.setUint8(offset + i, str.charCodeAt(i));
    }
    function writeInt16(offset, val) {
      view.setInt16(offset, val, true);
    }
    function writeUint32(offset, val) {
      view.setUint32(offset, val, true);
    }
    function writeUint16(offset, val) {
      view.setUint16(offset, val, true);
    }

    writeStr(0, "RIFF");
    writeUint32(4, 36 + dataSize);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    writeUint32(16, 16);
    writeUint16(20, 1); // PCM
    writeUint16(22, numChannels);
    writeUint32(24, sampleRate);
    writeUint32(28, byteRate);
    writeUint16(32, blockAlign);
    writeUint16(34, bytesPerSample * 8);
    writeStr(36, "data");
    writeUint32(40, dataSize);

    // interleave channels
    let offset = 44;
    for (let i = 0; i < numSamples; i++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = buffer.getChannelData(ch)[i];
        const clamped = Math.max(-1, Math.min(1, sample));
        writeInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
        offset += 2;
      }
    }
    return new Blob([arrayBuffer], { type: "audio/wav" });
  }

  document
    .getElementById("tempo-slider")
    .addEventListener("input", function () {
      changeTempo(this.value);
    });

  // در حالت موبایل خود اسلایدر غیرفعال است (pointer-events: none در CSS)
  // و با لمس کل ردیف (اسلایدر + عدد تمپو)، مودال تنظیم دقیق باز می‌شود.
  // روی کل ردیف گوش می‌دهیم نه فقط روی متن عدد، چون هدف لمسی متن خیلی کوچک
  // است و چون اسلایدر pointer-events:none دارد، لمس روی محدوده‌ی آن هم
  // به همین ردیف می‌رسد.
  const tempoRow = document.querySelector(".tempo-slider-row");
  if (tempoRow) {
    // click برای دسکتاپ
    tempoRow.addEventListener("click", function () {
      if (!isMobileLayout()) return;
      openTempoModal();
    });

    // touchend برای موبایل — چون اسلایدر pointer-events:none دارد،
    // رویداد لمسی مستقیم به این row می‌رسد ولی click ممکن است
    // در بعضی مرورگرهای موبایل تأخیر داشته یا نرسد.
    let _touchMoved = false;
    tempoRow.addEventListener(
      "touchstart",
      function () {
        _touchMoved = false;
      },
      { passive: true },
    );
    tempoRow.addEventListener(
      "touchmove",
      function () {
        _touchMoved = true;
      },
      { passive: true },
    );
    tempoRow.addEventListener("touchend", function (e) {
      if (_touchMoved) return; // اگر کاربر اسکرول کرده بود، باز نشود
      if (!isMobileLayout()) return;
      e.preventDefault(); // جلوگیری از تولید click تکراری
      openTempoModal();
    });
  }
  // ══════════════════════════════════════
  // ESHARAH SYSTEM (سیستم اشاره)
  // ══════════════════════════════════════
  // ══════════════════════════════════════
  // ESHARAH SYSTEM (سیستم اشاره)
  // ══════════════════════════════════════
  function openEsharahModal() {
    // if (!state.name) {
    //   return toast("ابتدا یک قطعه ایجاد کنید", true);
    // }

    const audioSounds =
      typeof sounds !== "undefined" ? sounds : window.sounds || null;

    if (!audioSounds || Object.keys(audioSounds).length === 0) {
      return toast("لطفاً ابتدا سمپل‌ها (صداها) را بارگذاری کنید", true);
    }

    const sampleNames = Object.keys(audioSounds).map((name) => {
      return name.toLowerCase().endsWith(".wav") ? name.slice(0, -4) : name;
    });

    const allSelects = document.querySelectorAll("#esharah-list select");
    allSelects.forEach((select) => {
      const currentVal = select.value;

      // تغییر متن پیش‌فرض همه‌ی کمبوباکس‌ها به None
      select.innerHTML = `<option value="">None</option>`;

      sampleNames.forEach((name) => {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
      });

      if (currentVal && sampleNames.includes(currentVal)) {
        select.value = currentVal;
      }
    });

    const modalEl = document.getElementById("modal-esharah");
    if (modalEl) {
      modalEl.classList.add("show");
    }

    // بازنمایی preview برای اشاره‌هایی که قبلاً set شده‌اند
    const rows = document.querySelectorAll("#esharah-list .esharah-row");
    rows.forEach((rowEl) => {
      const sym = rowEl
        .querySelector("span[style*='monospace']")
        ?.textContent?.trim();
      if (!sym) return;
      const cfg = state.esharahSettings && state.esharahSettings[sym];

      // بازیابی مقادیر select از state
      if (cfg && cfg.sel1) {
        const sel1El = rowEl.querySelector(".esharah-sel-1");
        const sel2El = rowEl.querySelector(".esharah-sel-2");
        if (sel1El && sampleNames.includes(cfg.sel1)) sel1El.value = cfg.sel1;
        if (sel2El && cfg.sel2 && sampleNames.includes(cfg.sel2))
          sel2El.value = cfg.sel2;

        // نمایش preview
        const previewEl = rowEl.querySelector(".esharah-preview");
        if (previewEl) {
          const label = cfg.sel2 ? `${cfg.sel1}  +  ${cfg.sel2}` : cfg.sel1;
          previewEl.textContent = `[ ${label} ] → ${sym}`;
          previewEl.style.color = "var(--accent)";
        }

        // فعال‌سازی دکمه پلی
        const playBtn = rowEl.querySelector(".esharah-play-btn");
        if (playBtn) {
          playBtn.disabled = false;
          playBtn.style.opacity = "1";
          playBtn.style.pointerEvents = "auto";
        }
      }
    });
  }

  function setEsharah(sym, btnEl) {
    const rowEl = btnEl.closest(".esharah-row");
    const sel1 = rowEl.querySelector(".esharah-sel-1").value;
    const sel2 = rowEl.querySelector(".esharah-sel-2").value;

    if (!sel1) {
      return toast("لطفاً انتخاب ۱ را مشخص کنید", true);
    }

    // ذخیره واقعی در state برنامه
    state.esharahSettings[sym] = {
      sel1: sel1,
      sel2: sel2 || "",
    };

    // بروزرسانی نمایش preview
    const previewEl = rowEl.querySelector(".esharah-preview");
    if (previewEl) {
      const label = sel2 ? `${sel1}  +  ${sel2}` : sel1;
      previewEl.textContent = `[ ${label} ] → ${sym}`;
      previewEl.style.color = "var(--accent)";
    }

    // فعال کردن دکمه پلی
    const playBtn = rowEl.querySelector(".esharah-play-btn");
    if (playBtn) {
      playBtn.disabled = false;
      playBtn.style.opacity = "1";
      playBtn.style.pointerEvents = "auto";
    }

    markDirty();
    toast(`تنظیمات اشاره (${sym}) اعمال شد ✓`);
  }

  function playEsharahPreview(sym, btnEl) {
    const cfg = state.esharahSettings && state.esharahSettings[sym];
    if (!cfg || !cfg.sel1) return toast("اشاره‌ای تنظیم نشده", true);

    const ctx = getAudioCtx();
    // زمان‌بندی دقیقاً مثل buildTimeline:
    // totalEsharahSec = کل زمان اشاره، singleTechSec = نصف آن
    const totalEsharahSec = ESHARAH_TOTAL_DURATION / 1000;
    const singleTechSec = totalEsharahSec / 2;

    // نت اصلی (dummy) را در زمان totalEsharahSec بعد از شروع قرار می‌دهیم
    // تا اشاره‌ها بتوانند قبل از آن پخش شوند
    const baseTime = ctx.currentTime + 0.05 + totalEsharahSec;

    // sel1: totalEsharahSec قبل از نت اصلی
    const buf1 = resolveSound(cfg.sel1);
    if (buf1) {
      const src1 = ctx.createBufferSource();
      src1.buffer = buf1;
      src1.connect(ctx.destination);
      src1.start(baseTime - totalEsharahSec); // = ctx.currentTime + 0.05
    }

    if (cfg.sel2 && cfg.sel2 !== "") {
      // sel2: singleTechSec قبل از نت اصلی
      const buf2 = resolveSound(cfg.sel2);
      if (buf2) {
        const src2 = ctx.createBufferSource();
        src2.buffer = buf2;
        src2.connect(ctx.destination);
        src2.start(baseTime - singleTechSec);
      }
    }

    // نت اصلی خودِ sym (تکنیک اشاره‌دار) در زمان baseTime
    const bufMain = resolveSound(sym);
    if (bufMain) {
      const srcMain = ctx.createBufferSource();
      srcMain.buffer = bufMain;
      srcMain.connect(ctx.destination);
      srcMain.start(baseTime);
    }

    // فیدبک بصری روی دکمه
    btnEl.textContent = "▶ ...";
    const totalMs = (totalEsharahSec + 0.3) * 1000;
    setTimeout(() => {
      btnEl.textContent = "▶ پلی";
    }, totalMs);
  }

  // ══════════════════════════════════════
  // INJECT ROW CONTEXT MENU DOM
  // ══════════════════════════════════════
  (function injectRowContextMenu() {
    if (document.getElementById("row-context-menu")) return;
    const el = document.createElement("div");
    el.id = "row-context-menu";
    document.body.appendChild(el);
  })();

  (function injectCellContextMenu() {
    if (document.getElementById("cell-context-menu")) return;
    const el = document.createElement("div");
    el.id = "cell-context-menu";
    document.body.appendChild(el);
  })();

  return {
    newFile,
    cancelNew,
    confirmNew,
    openFile,
    saveFile: saveFileWithSounds,
    saveAs,
    confirmSaveAs,
    insertRow,
    deleteRow,
    appendRow,
    insertRowAfter,
    copyRow,
    pasteRow,
    pasteRowReplace,
    removeRow,
    changeTempo,
    openTempoModal,
    cancelTempoModal,
    confirmTempoModal,
    loadSounds,
    viewSounds,
    playOnce,
    playLoop,
    playLongLoop,
    playFromSelected,
    playOnlySelected,
    confirmLongLoop,
    startLongLoopTimer,
    saveWav,
    confirmSaveWav,
    openTripletModal,
    confirmTriplet,
    openEsharahModal,
    setEsharah,
    playEsharahPreview,
  };
})();
