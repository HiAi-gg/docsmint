import { initWebVitals } from "$lib/vitals";

// Initialize web vitals tracking on client
if (typeof window !== "undefined") {
	initWebVitals();

	if ("serviceWorker" in navigator) {
		const registerServiceWorker = () => {
			const reloadOnce = () => {
				const key = "docsmint-sw-reload";
				if (sessionStorage.getItem(key)) return;
				sessionStorage.setItem(key, "1");
				window.location.reload();
			};
			navigator.serviceWorker.addEventListener("controllerchange", reloadOnce, {
				once: true,
			});
			void navigator.serviceWorker
				.register("/sw.js", { scope: "/" })
				.then((registration) => {
					registration.waiting?.postMessage({ type: "SKIP_WAITING" });
				})
				.catch(() => {
					// Offline support is progressive enhancement. A registration error
					// must never interrupt Svelte hydration or product interactions.
				});
		};

		if (document.readyState === "complete") {
			registerServiceWorker();
		} else {
			window.addEventListener("load", registerServiceWorker, { once: true });
		}
	}
}
