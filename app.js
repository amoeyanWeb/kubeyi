const app = (() => {
  // ══════════════════════════════════════
  // STATE
  // ══════════════════════════════════════
  let state = {
    name: "",
    meter: "4/4",
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
      state = saved;
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

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDynamicsMenu();
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

  function openTripletModal() {
    if (!state.name) return toast("ابتدا یک قطعه ایجاد کنید", true);
    document.getElementById("inp-tuplet-row").value =
      state.selected >= 0 ? state.selected + 1 : "";
    document.getElementById("inp-tuplet-col").value = "";
    // پیش‌فرض اولین رادیو
    const radios = document.querySelectorAll('input[name="tuplet-type"]');
    if (radios.length) radios[0].checked = true;
    document.getElementById("modal-triplet").classList.add("show");
    setTimeout(() => document.getElementById("inp-tuplet-row").focus(), 100);
  }

  function confirmTriplet() {
    const ri = parseInt(document.getElementById("inp-tuplet-row").value) - 1;
    const ci = parseInt(document.getElementById("inp-tuplet-col").value) - 1;
    const typeRadio = document.querySelector(
      'input[name="tuplet-type"]:checked',
    );
    if (!typeRadio) return toast("نوع را انتخاب کنید", true);
    const type = typeRadio.value;

    document.getElementById("modal-triplet").classList.remove("show");

    // --- حذف تیوپلت ---
    if (type === "remove") {
      if (isNaN(ri) || ri < 0 || ri >= state.rows.length)
        return toast("شماره میزان نامعتبر است", true);
      if (isNaN(ci) || ci < 0 || ci >= state.cols)
        return toast("شماره تکنیک نامعتبر است", true);
      // پیدا کردن start واقعی tuplet در این ci یا هر ci‌ای که این ci درونش باشد
      let foundKey = null;
      if (state.triplets) {
        // اول چک کن خودش start باشه
        if (state.triplets[ri + "-" + ci]) {
          foundKey = ri + "-" + ci;
        } else {
          // بگرد ببین این ci درون کدام tuplet است
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

    // مقداردهی اولیه slot‌های اضافی در tripletData
    if (!state.tripletData) state.tripletData = {};
    // slot‌های 0..baseCols-1 از row گرفته می‌شن، slot‌های بعدی از tripletData
    // هر slot اضافی (index >= baseCols) باید در tripletData باشد
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
      badge.textContent = "دیتا موجود نیست";
      badge.classList.remove("loaded");
    } else {
      badge.textContent = count + " صدا لود شد";
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
      // اگر modal باز بود، رفرش بشه
      const modal = document.getElementById("modal-viewsounds");
      if (modal && modal.classList.contains("show")) viewSounds();
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
      numEl.addEventListener("click", () => selectRow(ri));
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
          if (dynMenuState.ri === ri && dynMenuState.ci === ci) {
            closeDynamicsMenu();
          } else {
            openDynamicsMenu(ri, ci, inp);
          }
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
              if (dynMenuState.ri === ri && dynMenuState.ci === ci) {
                closeDynamicsMenu();
              } else {
                openDynamicsMenu(ri, ci, inp);
              }
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

        // در موبایل: تپ ساده روی خانه‌ای که متن دارد، هم امکان ویرایش متن
        // (فوکوس و کیبورد) را حفظ می‌کند و هم منوی دینامیک را باز/بسته می‌کند
        inp.addEventListener("click", (e) => {
          if (longPressFired) {
            // قبلاً با long-press باز/بسته شد، دوباره toggle نشود
            longPressFired = false;
            return;
          }
          if (!isMobile) return;
          if (!inp.value.trim()) return;
          e.stopPropagation();
          if (dynMenuState.ri === ri && dynMenuState.ci === ci) {
            closeDynamicsMenu();
          } else {
            openDynamicsMenu(ri, ci, inp);
          }
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
    document.getElementById("inp-tempo").value = 120;
    document.getElementById("inp-meter").value = "4/4";
    document.getElementById("inp-initrows").value = 16;
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
    return header + body + tripletPart + tripletDataPart + tupletDynPart;
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
    saveFile();
  }

  function openFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".txt";
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = deserialize(ev.target.result);
          state = {
            ...parsed,
            selected: -1,
            clipboard: null,
            clipboardDynamics: null,
            filename: file.name.replace(".txt", ""),
            dirty: false,
          };
          render();
          persistAutosave();
          toast(`"${state.name}" باز شد`);
        } catch (err) {
          toast("خطا در باز کردن فایل: " + err.message, true);
        }
      };
      reader.readAsText(file);
    };
    input.click();
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
        saveFile();
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
  function resolveSound(symbol) {
    if (!symbol || symbol === "-") return null;
    const keys = Object.keys(sounds);
    // exact match with .wav
    const exact = keys.find(
      (k) => k.toLowerCase() === symbol.toLowerCase() + ".wav",
    );
    if (exact) return sounds[exact];
    // fallback: starts with symbol (case-insensitive)
    const partial = keys.find((k) =>
      k.toLowerCase().startsWith(symbol.toLowerCase() + "."),
    );
    if (partial) return sounds[partial];
    return null;
  }

  // build a flat list of {symbol, startSec, durationSec} events from current state
  function buildTimeline() {
    const { rows, cols, tempo, meter, triplets, tripletData, tupletDynamics } =
      state;
    const den = parseInt(meter.split("/")[1] || 4);
    const subdivsPerBeat = den <= 4 ? 4 : 2;
    const cellDur = 60 / tempo / subdivsPerBeat;

    const events = [];
    let t = 0;

    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      let ci = 0;
      while (ci < cols) {
        // بررسی tuplet
        const tuplet = triplets && triplets[ri + "-" + ci];
        if (tuplet && tuplet.baseCols) {
          const totalDur = tuplet.baseCols * cellDur;
          const noteDur = totalDur / tuplet.slots;
          for (let slot = 0; slot < tuplet.slots; slot++) {
            let sym = "";
            if (slot < tuplet.baseCols) {
              sym = (row[ci + slot] || "").trim();
            } else {
              sym = (
                (tripletData && tripletData[`${ri}-${ci}-${slot}`]) ||
                ""
              ).trim();
            }
            if (sym && sym !== "-") {
              // دینامیک
              let dyn = "";
              if (slot < tuplet.baseCols) {
                dyn = getCellDynamic(ri, ci + slot);
              } else {
                dyn =
                  (tupletDynamics && tupletDynamics[`${ri}-${ci}-${slot}`]) ||
                  "";
              }
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
          t += totalDur;
          ci += tuplet.baseCols;
          continue;
        }

        // سلول‌های درون tuplet رد می‌شوند (چون در iteration قبلی مصرف شدند)
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
        // count duration: sym + following '-' cells
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

    return { events, totalDur: t };
  }

  // اعمال حجم بر اساس نوانس (ff..pp) یا شکل قوسی (< > <>) روی یک gainNode
  // absStart: زمان مطلق شروع نت در AudioContext/OfflineAudioContext
  // bufDur: طول کامل فایل صوتی منبع
  function applyNoteGain(gainNode, ev, absStart, bufDur) {
    const dyn = ev.dynamic || "";
    const playDur = ev.durationSec;
    const trim = bufDur > playDur; // باید زودتر از پایان فایل صدا قطع شود
    const span = trim ? playDur : bufDur;
    const fadeOutDur = trim
      ? Math.min(0.08, playDur * 0.2)
      : Math.min(0.05, bufDur * 0.25);
    const shapeSpan = Math.max(0.001, span - fadeOutDur);
    const fadeEndVal = trim ? 0 : 0.001;

    // مقدار اولیه gainNode به‌صورت پیش‌فرض 1.0 است.
    // برای جلوگیری از ramp ناخواسته از 1.0 به مقدار اول،
    // ابتدا زمان‌بندی‌ها را لغو کرده و مقدار را از زمان 0 صریحاً ست می‌کنیم.
    gainNode.gain.cancelScheduledValues(0);

    if (isShapeDynamic(dyn)) {
      const peak = DYNAMIC_GAIN.mf;
      const lo = peak * SHAPE_LOW_RATIO;
      if (dyn === "<") {
        // کرشندو: شروع ساکت، اوج در پایان بخش اصلی نت
        gainNode.gain.setValueAtTime(lo, 0);
        gainNode.gain.setValueAtTime(lo, absStart);
        gainNode.gain.linearRampToValueAtTime(peak, absStart + shapeSpan);
      } else if (dyn === ">") {
        // دیکرشندو: شروع بلند، ساکت‌شدن تا پایان بخش اصلی نت
        gainNode.gain.setValueAtTime(peak, 0);
        gainNode.gain.setValueAtTime(peak, absStart);
        gainNode.gain.linearRampToValueAtTime(lo, absStart + shapeSpan);
      } else {
        // قوسی (<>): ساکت → اوج در میانه → ساکت
        gainNode.gain.setValueAtTime(lo, 0);
        gainNode.gain.setValueAtTime(lo, absStart);
        gainNode.gain.linearRampToValueAtTime(peak, absStart + shapeSpan / 2);
        gainNode.gain.linearRampToValueAtTime(lo, absStart + shapeSpan);
      }
    } else {
      const g = DYNAMIC_GAIN[dyn] ?? DYNAMIC_GAIN.mf;
      gainNode.gain.setValueAtTime(g, 0);
      gainNode.gain.setValueAtTime(g, absStart);
    }
    gainNode.gain.linearRampToValueAtTime(fadeEndVal, absStart + span);
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

    function scheduleOnce(offset) {
      events.forEach((ev) => {
        const buf = resolveSound(ev.symbol);
        if (!buf) return;

        const src = ctx.createBufferSource();
        const gainNode = ctx.createGain();

        // trim buffer if needed (for tremolo / long sounds)
        const playDur = ev.durationSec;
        const bufDur = buf.duration;
        const absStart = offset + ev.startSec;

        applyNoteGain(gainNode, ev, absStart, bufDur);
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

    scheduleOnce(ctx.currentTime);

    // if loop, schedule next repetition slightly before end
    if (loop) {
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
          scheduleOnce(nextStart);
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

        applyNoteGain(gainNode, ev, absStart, bufDur);
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

        applyNoteGain(gainNode, ev, ev.startSec, bufDur);
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

  return {
    newFile,
    cancelNew,
    confirmNew,
    openFile,
    saveFile,
    saveAs,
    confirmSaveAs,
    insertRow,
    deleteRow,
    appendRow,
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
    confirmLongLoop,
    startLongLoopTimer,
    saveWav,
    confirmSaveWav,
    openTripletModal,
    confirmTriplet,
  };
})();
