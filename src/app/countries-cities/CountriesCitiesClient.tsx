"use client";

import { useMemo, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
} from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import styles from "./CountriesCitiesClient.module.css";
import AddCountryModal from "../components/AddCountryModal";
import AddCityModal from "../components/AddCityModal";
import { showToastMessage } from "../../lib/toast";
import { showConfirmDialog } from "../../lib/confirm";
import type { CountryRow } from "./page";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading countries…</div>,
});

const sortByName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

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

type Props = {
  countries: CountryRow[];
};

export default function CountriesCitiesClient({ countries }: Props) {
  const [rows, setRows] = useState<CountryRow[]>(() => countries ?? []);
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [isAddCityOpen, setIsAddCityOpen] = useState(false);

  const maxCities = useMemo(
    () => rows.reduce((max, row) => Math.max(max, row.cities.length), 0),
    [rows],
  );

  const [refreshToken, setRefreshToken] = useState(0);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api) return;
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
      setRows((prev) => {
        const next = [...prev, { id: country.id, name: country.name, cities: [] }];
        next.sort((a, b) => sortByName(a.name, b.name));
        return next;
      });
      showToastMessage("Country added", "success");
      setRefreshToken((prev) => prev + 1);
    },
    [],
  );

  const handleCityCreated = useCallback(
    (city: { id: number; name: string; countryId: number | null; enabled: boolean }) => {
      setIsAddCityOpen(false);
      if (!city.enabled) {
        showToastMessage("City added (disabled)", "success");
        return;
      }
      if (city.countryId == null) {
        showToastMessage("City added", "success");
        return;
      }
      setRows((prev) => {
        const next = prev.map((row) => {
          if (row.id !== city.countryId) return row;
          const cities = [...row.cities, city.name].sort(sortByName);
          return { ...row, cities };
        });
        return next;
      });
      showToastMessage("City added", "success");
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
      if (!field) return;
      if (event.newValue === event.oldValue) return;

      const countryId = (event.data as { CountryID?: unknown } | null)?.CountryID;
      if (typeof countryId !== "number") return;

      const value = typeof event.newValue === "string" ? event.newValue.trim() : String(event.newValue ?? "").trim();
      if (!value) {
        showToastMessage("Value is required.", "error");
        revertCell(event);
        return;
      }

      let payload: { updates: Array<Record<string, unknown>> } | null = null;

      if (field === "Country") {
        payload = {
          updates: [{ CountryID: countryId, field: "Country", value }],
        };
      } else if (field.startsWith("City")) {
        const cityIdKey = `${field}Id`;
        const cityId = (event.data as Record<string, unknown>)[cityIdKey];
        if (typeof cityId !== "number") {
          showToastMessage("Cannot edit an empty city. Use Add New City.", "error");
          revertCell(event);
          return;
        }
        payload = {
          updates: [{ CountryID: countryId, field, value, cityId }],
        };
      } else {
        return;
      }

      const submit = async () => {
        try {
          const res = await fetch("/api/countries-cities", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !data?.ok) {
            throw new Error(data?.error ?? "Update failed");
          }

          if (field === "Country") {
            setRows((prev) => {
              const next = prev.map((row) => (row.id === countryId ? { ...row, name: value } : row));
              next.sort((a, b) => sortByName(a.name, b.name));
              return next;
            });
          }
          showToastMessage("Updated", "success");
          setRefreshToken((prev) => prev + 1);
        } catch (err) {
          console.error("Failed to update cell", err);
          showToastMessage("Unable to update. Please try again.", "error");
          revertCell(event);
        }
      };

      void submit();
    },
    [setRows],
  );

  const deleteCountry = useCallback(
    async (countryId: number, countryName: string | null) => {
      if (!Number.isFinite(countryId) || countryId <= 0) return;
      const label = countryName?.trim() || `#${countryId}`;

      const confirmed = await showConfirmDialog({
        title: "Delete country",
        message: `Delete country "${label}"? This will also delete all cities in this country. This action cannot be undone.`,
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
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string }
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to delete country");
        }

        setRows((prev) => prev.filter((row) => row.id !== countryId));
        showToastMessage("Country deleted", "success");
        setRefreshToken((prev) => prev + 1);
      } catch (err) {
        console.error("Failed to delete country", err);
        showToastMessage(err instanceof Error ? err.message : "Unable to delete country.", "error");
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
      baseItems.push({
        name: "Delete Country",
        icon: deleteMenuIcon,
        action: () => {
          void deleteCountry(countryId, countryName);
        },
      });
      return baseItems;
    },
    [deleteCountry],
  );

  const columnDefs = useMemo<ColDef[]>(() => {
    const base: ColDef[] = [
      {
        field: "Country",
        headerName: "Country",
        filter: "agTextColumnFilter",
        editable: true,
      },
    ];
    for (let i = 0; i < maxCities; i += 1) {
      base.push({
        field: `City${i + 1}`,
        headerName: `City ${i + 1}`,
        filter: "agTextColumnFilter",
        editable: true,
      });
    }
    return base;
  }, [maxCities]);

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Countries & Cities"
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={() => setIsAddCountryOpen(true)}
              >
                Add New Country
              </button>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={() => setIsAddCityOpen(true)}
              >
                Add New City
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
                columnStateNamespace="countries-cities"
                onGridReady={handleGridReady}
                onCellEditingStarted={handleCellEditingStarted}
                onCellValueChanged={handleCellEdit}
                getContextMenuItems={getContextMenuItems}
                refreshToken={refreshToken}
                suppressRowClickSelection
                suppressMovableColumns
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
      <AddCityModal
        open={isAddCityOpen}
        onClose={() => setIsAddCityOpen(false)}
        onCreated={handleCityCreated}
        countries={rows.map((row) => ({ id: row.id, name: row.name }))}
      />
    </>
  );
}
