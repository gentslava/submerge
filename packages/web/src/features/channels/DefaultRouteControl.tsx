import type { DefaultRoute } from "@submerge/shared";
import { LabeledControlRow } from "@/components/ui/labeled-control-row";
import { Segmented } from "@/components/ui/segmented";

export function DefaultRouteControl({
  route,
  pending,
  error,
  onChange,
}: {
  route: DefaultRoute;
  pending: boolean;
  error: string | null;
  onChange: (route: DefaultRoute) => void;
}) {
  return (
    <div className="default-route-control border-b border-border-subtle">
      <LabeledControlRow
        label="Всё остальное"
        sub={
          route === "direct"
            ? "Напрямую с IP-адреса сервера. Через VPN — только по отдельным правилам."
            : "Через VPN, если трафик не совпал с другими правилами."
        }
      >
        <div className="settings-field-260 w-full">
          <Segmented
            stretch
            aria-label="Маршрут по умолчанию"
            value={route}
            disabled={pending}
            options={[
              { value: "direct", label: "Напрямую" },
              { value: "proxy", label: "Через VPN" },
            ]}
            onChange={(value) => {
              if (!pending && value !== route) onChange(value as DefaultRoute);
            }}
          />
        </div>
      </LabeledControlRow>
      {pending && (
        <p role="status" className="px-[18px] pb-4 text-sub text-text-secondary">
          Применяем маршрут…
        </p>
      )}
      {error && !pending && (
        <p role="alert" className="px-[18px] pb-4 text-sub text-timeout">
          {error}
        </p>
      )}
    </div>
  );
}
