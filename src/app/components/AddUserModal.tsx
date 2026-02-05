"use client";

import { useCallback, useEffect, useState } from "react";
import LookupModal from "./LookupModal";
import lookupStyles from "./LookupModal.module.css";
import { showToastMessage } from "../../lib/toast";

const USER_CREATE_ENDPOINT = "/api/user-management";

type CreateUserResponse = {
  ok?: boolean;
  error?: string;
  user?: { id?: number | null } | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (user: { id: number }) => void;
  roles: string[];
  salesDivisions: string[];
  salesSeniorities: string[];
};

export default function AddUserModal({
  open,
  onClose,
  onCreated,
  roles,
  salesDivisions,
  salesSeniorities,
}: Props) {
  const [userName, setUserName] = useState("");
  const [windowsUserName, setWindowsUserName] = useState("");
  const [role, setRole] = useState("");
  const [fullName, setFullName] = useState("");
  const [fullNameGR, setFullNameGR] = useState("");
  const [email, setEmail] = useState("");
  const [signTitle, setSignTitle] = useState("");
  const [nameCode, setNameCode] = useState("");
  const [salesDivision, setSalesDivision] = useState("");
  const [salesSeniority, setSalesSeniority] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setUserName("");
    setWindowsUserName("");
    setRole("");
    setFullName("");
    setFullNameGR("");
    setEmail("");
    setSignTitle("");
    setNameCode("");
    setSalesDivision("");
    setSalesSeniority("");
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) resetForm();
  }, [open, resetForm]);

  const handleCreate = useCallback(async () => {
    const trimmedUserName = userName.trim();
    const trimmedWindowsUserName = windowsUserName.trim();
    const trimmedRole = role.trim();

    if (!trimmedUserName) {
      setError("User name is required.");
      return;
    }
    if (!trimmedWindowsUserName) {
      setError("Windows user name is required.");
      return;
    }
    if (!trimmedRole) {
      setError("Role is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        userName: trimmedUserName,
        windowsUserName: trimmedWindowsUserName,
        role: trimmedRole,
        fullName: fullName.trim() || null,
        fullNameGR: fullNameGR.trim() || null,
        email: email.trim() || null,
        signTitle: signTitle.trim() || null,
        nameCode: nameCode.trim() || null,
        salesDivision: salesDivision.trim() || null,
        salesSeniority: salesSeniority.trim() || null,
      };

      const response = await fetch(USER_CREATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as CreateUserResponse | null;
      if (!response.ok || !result?.ok || !result.user?.id) {
        const message = result?.error ?? "Unable to create user.";
        throw new Error(message);
      }

      showToastMessage("User added", "success");
      onCreated?.({ id: result.user.id });
      onClose();
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create user.";
      setError(message);
      showToastMessage(message, "error");
    } finally {
      setSaving(false);
    }
  }, [
    email,
    fullName,
    fullNameGR,
    nameCode,
    onClose,
    onCreated,
    resetForm,
    role,
    salesDivision,
    salesSeniority,
    signTitle,
    userName,
    windowsUserName,
  ]);

  return (
    <LookupModal
      open={open}
      title="Add User"
      onClose={onClose}
      onConfirm={handleCreate}
      confirmLabel="Create"
      saving={saving}
      error={error}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-name">
            User Name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="user-name"
            className={lookupStyles.fieldControl}
            value={userName}
            required
            onChange={(event) => setUserName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="windows-user-name">
            Windows User Name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="windows-user-name"
            className={lookupStyles.fieldControl}
            value={windowsUserName}
            required
            onChange={(event) => setWindowsUserName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-role">
            Role <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <select
            id="user-role"
            className={lookupStyles.fieldControl}
            value={role}
            required
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="">Select role...</option>
            {roles.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-email">
            Email
          </label>
          <input
            id="user-email"
            className={lookupStyles.fieldControl}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-full-name">
            Full Name
          </label>
          <input
            id="user-full-name"
            className={lookupStyles.fieldControl}
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-full-name-gr">
            Full Name (GR)
          </label>
          <input
            id="user-full-name-gr"
            className={lookupStyles.fieldControl}
            value={fullNameGR}
            onChange={(event) => setFullNameGR(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-sign-title">
            Sign Title
          </label>
          <input
            id="user-sign-title"
            className={lookupStyles.fieldControl}
            value={signTitle}
            onChange={(event) => setSignTitle(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-name-code">
            Name Code
          </label>
          <input
            id="user-name-code"
            className={lookupStyles.fieldControl}
            value={nameCode}
            onChange={(event) => setNameCode(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-sales-division">
            Sales Division
          </label>
          <select
            id="user-sales-division"
            className={lookupStyles.fieldControl}
            value={salesDivision}
            onChange={(event) => setSalesDivision(event.target.value)}
          >
            <option value="">Select sales division...</option>
            {salesDivisions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="user-sales-seniority">
            Sales Seniority
          </label>
          <select
            id="user-sales-seniority"
            className={lookupStyles.fieldControl}
            value={salesSeniority}
            onChange={(event) => setSalesSeniority(event.target.value)}
          >
            <option value="">Select sales seniority...</option>
            {salesSeniorities.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>
    </LookupModal>
  );
}
