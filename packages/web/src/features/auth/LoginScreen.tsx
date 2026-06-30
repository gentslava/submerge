import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useTRPC } from "@/lib/trpc";

export function LoginScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [password, setPassword] = useState("");
  const login = useMutation(
    trpc.auth.login.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries();
        toast.success("Добро пожаловать");
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="flex min-h-dvh items-center justify-center bg-canvas p-4">
      <Card className="w-full max-w-sm p-6">
        <h1 className="mb-1 text-lg font-semibold text-text-primary">submerge</h1>
        <p className="mb-4 text-sm text-text-secondary">Введите пароль администратора</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password) login.mutate({ password });
          }}
          className="flex flex-col gap-3"
        >
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Пароль"
            autoFocus
          />
          <Button type="submit" disabled={login.isPending}>
            {login.isPending ? "Вход…" : "Войти"}
          </Button>
        </form>
      </Card>
    </div>
  );
}
