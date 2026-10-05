(() => {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.()) return;

  const app = capacitor.registerPlugin('App');
  app.addListener('backButton', ({ canGoBack }) => {
    const openDialog = document.querySelector('dialog[open]');
    if (openDialog) {
      openDialog.close();
      return;
    }

    const navigation = document.querySelector('#mainNav');
    if (navigation?.classList.contains('open')) {
      navigation.classList.remove('open');
      document.querySelector('#mobileMenu')?.setAttribute('aria-expanded', 'false');
      return;
    }

    const sidebar = document.querySelector('#conversationSidebar');
    if (sidebar?.classList.contains('open')) {
      sidebar.classList.remove('open');
      document.querySelector('#historyToggle')?.setAttribute('aria-expanded', 'false');
      return;
    }

    if (canGoBack && window.history.length > 1) {
      window.history.back();
      return;
    }

    app.exitApp();
  });
})();
