"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  MenuItemDef,
} from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import styles from "./CountriesClient.module.css";
import AddCountryModal from "../components/AddCountryModal";
import { showToastMessage } from "../../lib/toast";
import { showConfirmDialog } from "../../lib/confirm";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading countries…</div>,
});

const deleteMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--danger" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 7L18.2 19.2C18.1 20.8 16.8 22 15.2 22H8.8C7.2 22 5.9 20.8 5.8 19.2L5 7" />
      <path d="M10 11V17" />
      <path d="M14 11V17" />
      <path d="M4 7H20" />
      <path d="M9 7V4.8C9 3.8 9.8 3 10.8 3H13.2C14.2 3 15 3.8 15 4.8V7" />
    </svg>
  </span>
`;

export default function CountriesClient() {
  const router = useRouter();
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  const handleGridReady = useCallback(() => {
  }, []);

  const handleCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<Record<string, unknown>>) => {
      const editors = event.api.getCellEditorInstances() ?? [];
      for (const editor of editors) {
        const gui = (editor as { getGui?: () => HTMLElement | null }).getGui?.();
        if (!gui) continue;
        const input = gui.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement | null;
        if (!input) continue;
        input.setAttribute("autocomplete", "off");
        input.setAttribute("autocorrect", "off");
        input.setAttribute("autocapitalize", "off");
        input.setAttribute("spellcheck", "false");
      }
    },
    [],
  );

  const handleCountryCreated = useCallback(
    (country: { id: number; name: string; enabled: boolean }) => {
      setIsAddCountryOpen(false);
      if (!country.enabled) {
        showToastMessage("Country added (disabled)", "success");
        return;
      }
      showToastMessage("Country added", "success");
      setRefreshToken((prev) => prev + 1);
    },
    [],
  );

  const revertCell = (event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.node) {
      try {
        event.node.setDataValue(event.colDef.field ?? "", event.oldValue);
        return;
      } catch {
        /* noop */
      }
    }
    event.api.refreshCells({ force: true });
  };

  const handleCellEdit = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (field !== "Country") return;
      if (event.newValue === event.oldValue) return;

      const countryId = (event.data as { CountryID?: unknown } | null)?.CountryID;
      if (typeof countryId !== "number") return;

      const value = typeof event.newValue === "string" ? event.newValue.trim() : String(event.newValue ?? "").trim();
      if (!value) {
        showToastMessage("Value is required.", "error");
        revertCell(event);
        return;
      }

      const submit = async () => {
        try {
          const res = await fetch("/api/countries-cities", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ updates: [{ CountryID: countryId, field: "Country", value }] }),
          });
          const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !data?.ok) {
            throw new Error(data?.error ?? "Update failed");
          }

          showToastMessage("Updated", "success");
          setRefreshToken((prev) => prev + 1);
        } catch (err) {
          console.error("Failed to update cell", err);
          showToastMessage(
            err instanceof Error ? err.message : "Unable to update. Please try again.",
            "error",
          );
          revertCell(event);
        }
      };

      void submit();
    },
    [],
  );

  const deleteCountry = useCallback(
    async (countryId: number, countryName: string | null) => {
      if (!Number.isFinite(countryId) || countryId <= 0) return;
      const label = countryName?.trim() || `#${countryId}`;

      const confirmed = await showConfirmDialog({
        title: "Delete country",
        message: `Delete country "${label}"? This action cannot be undone.`,
        confirmLabel: "Delete country",
        cancelLabel: "Keep country",
        tone: "danger",
      });
      if (!confirmed) return;

      try {
        const response = await fetch("/api/countries-cities", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ CountryIDs: [countryId] }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to delete country");
        }

        showToastMessage("Country deleted", "success");
        setRefreshToken((prev) => prev + 1);
      } catch (err) {
        console.error("Failed to delete country", err);
        showToastMessage(err instanceof Error ? err.message : "Unable to delete country.", "error");
      }
    },
    [],
  );

  const deleteCountries = useCallback(
    async (countriesToDelete: Array<{ id: number; name: string | null }>) => {
      const uniqueCountries = Array.from(
        new Map(
          countriesToDelete
            .filter((country) => Number.isFinite(country.id) && country.id > 0)
            .map((country) => [country.id, country]),
        ).values(),
      );
      if (uniqueCountries.length === 0) return;

      const names = uniqueCountries
        .map((country) => country.name?.trim())
        .filter((name): name is string => Boolean(name));
      const label =
        names.length > 0
          ? names.length <= 3
            ? names.join(", ")
            : `${names.length} countries`
          : `${uniqueCountries.length} countries`;

      const confirmed = await showConfirmDialog({
        title: "Delete countries",
        message: `Delete ${label}? This action cannot be undone.`,
        confirmLabel: "Delete countries",
        cancelLabel: "Keep countries",
        tone: "danger",
      });
      if (!confirmed) return;

      try {
        const response = await fetch("/api/countries-cities", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ CountryIDs: uniqueCountries.map((country) => country.id) }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to delete countries");
        }

        showToastMessage("Countries deleted", "success");
        setRefreshToken((prev) => prev + 1);
      } catch (err) {
        console.error("Failed to delete countries", err);
        showToastMessage(err instanceof Error ? err.message : "Unable to delete countries.", "error");
      }
    },
    [],
  );

  const getContextMenuItems = useCallback(
    (
      params: GetContextMenuItemsParams<Record<string, unknown>>,
    ): Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> => {
      const baseItems: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> =
        Array.isArray(params.defaultItems) ? [...params.defaultItems] : [];
      const data = (params.node?.data ?? null) as Record<string, unknown> | null;
      const selectedCountries = (params.api.getSelectedNodes?.() ?? [])
        .map((node) => {
          const row = (node?.data ?? null) as Record<string, unknown> | null;
          const rawId = row?.CountryID;
          const id =
            typeof rawId === "number"
              ? rawId
              : typeof rawId === "string"
                ? Number.parseInt(rawId, 10)
                : null;
          if (!id || !Number.isFinite(id)) return null;
          const name = typeof row?.Country === "string" ? row.Country : null;
          return { id, name };
        })
        .filter((entry): entry is { id: number; name: string | null } => Boolean(entry));
      const hasMultiSelection = selectedCountries.length > 1;
      const rawCountryId = data?.CountryID;
      const countryId =
        typeof rawCountryId === "number"
          ? rawCountryId
          : typeof rawCountryId === "string"
            ? Number.parseInt(rawCountryId, 10)
            : null;
      if (!countryId || !Number.isFinite(countryId)) return baseItems;
      const countryName = typeof data?.Country === "string" ? data.Country : null;

      if (baseItems.length > 0 && baseItems[baseItems.length - 1] !== "separator") {
        baseItems.push("separator");
      }
      if (hasMultiSelection) {
        baseItems.push({
          name: "Delete Countries",
          icon: deleteMenuIcon,
          action: () => {
            void deleteCountries(selectedCountries);
          },
        });
      } else {
        baseItems.push({
          name: "Delete Country",
          icon: deleteMenuIcon,
          action: () => {
            void deleteCountry(countryId, countryName);
          },
        });
      }
      return baseItems;
    },
    [deleteCountries, deleteCountry],
  );

  const columnDefs: ColDef[] = [
    {
      field: "Country",
      headerName: "Country",
      filter: "agTextColumnFilter",
      editable: true,
      flex: 1,
    },
  ];

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Countries"
          leftActions={
            <button
              type="button"
              className={`page-header-button ${styles.headerButton}`}
              onClick={() => router.push("/suppliers")}
            >
              <span aria-hidden="true">←</span>
              Back to Suppliers
            </button>
          }
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={() => setIsAddCountryOpen(true)}
              >
                Add New Country
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/countries-cities/grid"
                columnDefs={columnDefs}
                defaultColDef={{
                  editable: true,
                  cellEditor: "agTextCellEditor",
                }}
                columnStateNamespace="countries"
                onGridReady={handleGridReady}
                onCellEditingStarted={handleCellEditingStarted}
                onCellValueChanged={handleCellEdit}
                getContextMenuItems={getContextMenuItems}
                refreshToken={refreshToken}
                suppressMovableColumns
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <AddCountryModal
        open={isAddCountryOpen}
        onClose={() => setIsAddCountryOpen(false)}
        onCreated={handleCountryCreated}
      />
    </>
  );
}
