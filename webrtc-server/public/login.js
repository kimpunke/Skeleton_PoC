const apiHost = location.hostname || "localhost";
const apiPort = location.port || "3000";
const apiProtocol = location.protocol === "https:" ? "https:" : "http:";
const apiBase = location.protocol === "file:"
  ? "http://localhost:3000"
  : `${apiProtocol}//${apiHost}:${apiPort}`;

const authFormEl = document.getElementById("authForm");
const authUsernameEl = document.getElementById("authUsername");
const authPasswordEl = document.getElementById("authPassword");
const togglePasswordEl = document.getElementById("togglePassword");
const authErrorEl = document.getElementById("authError");

const setError = (text) => {
  if (authErrorEl) {
    authErrorEl.textContent = text || "";
  }
};

if (togglePasswordEl && authPasswordEl) {
  togglePasswordEl.addEventListener("click", () => {
    const isPassword = authPasswordEl.type === "password";
    authPasswordEl.type = isPassword ? "text" : "password";
    togglePasswordEl.textContent = isPassword ? "Hide" : "Show";
  });
}

if (authFormEl) {
  authFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    setError("");

    const username = authUsernameEl ? authUsernameEl.value.trim() : "";
    const password = authPasswordEl ? authPasswordEl.value : "";
    if (!username || !password) {
      setError("Enter username and password");
      return;
    }

    try {
      const response = await fetch(`${apiBase}/api/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });

      if (!response.ok) {
        let errorPayload = null;
        try {
          errorPayload = await response.json();
        } catch (parseError) {
          errorPayload = null;
        }
        if (errorPayload && errorPayload.error === "pending-approval") {
          setError("Pending admin approval");
        } else {
          setError("Login failed");
        }
        return;
      }

      location.href = "/";
    } catch (error) {
      setError("Login failed");
    }
  });
}

if (authUsernameEl) {
  authUsernameEl.focus();
}
