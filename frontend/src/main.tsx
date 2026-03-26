import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import { LoginPage } from "./auth/LoginPage";
import { ActivatePage } from "./auth/ActivatePage";
import { ForgotPasswordPage } from "./auth/ForgotPasswordPage";
import "./styles.css";

function Root() {
  const { isAuthenticated } = useAuth();

  const params = new URLSearchParams(window.location.search);
  const activationCode = params.get("code");
  const isActivatePath = window.location.pathname === "/activate";

  if (isActivatePath && activationCode) {
    return <ActivatePage code={activationCode} />;
  }

  if (window.location.pathname === "/forgot-password") {
    return <ForgotPasswordPage />;
  }

  return isAuthenticated ? <App /> : <LoginPage />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthProvider>
      <Root />
    </AuthProvider>
  </React.StrictMode>
);
