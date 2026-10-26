window.TMA = {
  tg: window.Telegram?.WebApp || null,

  initApp() {
    if (this.tg) {
      this.tg.ready();
      this.tg.expand();
      if (typeof this.tg.disableVerticalSwipes === 'function') {
        this.tg.disableVerticalSwipes();
      }
    }
    // Prevent right-click context menu on study material
    document.addEventListener('contextmenu', (e) => e.preventDefault());
  },

  triggerHaptic(type = 'light') {
    if (!this.tg || !this.tg.HapticFeedback) return;
    try {
      if (type === 'success' || type === 'error' || type === 'warning') {
        this.tg.HapticFeedback.notificationOccurred(type);
      } else {
        this.tg.HapticFeedback.impactOccurred(type);
      }
    } catch (_) {}
  },

  getUserWatermark() {
    const user = this.tg?.initDataUnsafe?.user;
    if (user) {
      return user.username ? `@${user.username} • ${user.id}` : `ID:${user.id}`;
    }
    return '@UT_Student_Demo • 981024';
  },

  saveProgress(key, valueObj) {
    const raw = JSON.stringify(valueObj);
    try {
      localStorage.setItem(key, raw);
    } catch (_) {}

    if (this.tg?.CloudStorage) {
      try {
        this.tg.CloudStorage.setItem(key, raw);
      } catch (_) {}
    }
  },

  loadProgress(key, callback) {
    if (this.tg?.CloudStorage) {
      try {
        this.tg.CloudStorage.getItem(key, (err, val) => {
          if (!err && val) {
            callback(JSON.parse(val));
            return;
          }
          this._loadLocal(key, callback);
        });
        return;
      } catch (_) {}
    }
    this._loadLocal(key, callback);
  },

  _loadLocal(key, callback) {
    try {
      const saved = localStorage.getItem(key);
      callback(saved ? JSON.parse(saved) : {});
    } catch (_) {
      callback({});
    }
  }
};