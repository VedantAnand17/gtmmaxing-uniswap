import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSignIn } from "../../lib/mockSession";
import { ArcPage } from "./ArcPage";

vi.mock("../../lib/apiClient", async () => ({ api: (await import("../../lib/mockApi")).mockApi }));
vi.mock("../../lib/navigation", () => ({ leavePage: vi.fn() }));

const ADDRESS = "0x1111111111111111111111111111111111111111";
const mount = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><ArcPage /></QueryClientProvider>);

function fakeWallet(switchError?: { code: number }) {
  const calls: { method: string; params?: unknown[] }[] = [];
  let added = false;
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: async (call: { method: string; params?: unknown[] }) => {
      calls.push(call);
      if (call.method === "eth_requestAccounts") return [ADDRESS];
      if (call.method === "wallet_addEthereumChain") { added = true; return null; }
      if (call.method === "wallet_switchEthereumChain") { if (switchError && !added) throw switchError; return null; }
      if (call.method === "eth_sendTransaction") return `0x${"12".repeat(32)}`;
      if (call.method === "eth_getTransactionReceipt") return { status: "0x1" };
      return null;
    },
  };
  return calls;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe("Arc test checkout", () => {
  it("says up front that this is a test and adds no credits", async () => {
    mockSignIn();
    mount();
    expect(await screen.findByText(/doesn't add credits/)).toBeTruthy();
  });

  it("adds the network if the wallet lacks it, sends USDC in 6 decimals through the ERC-20 interface, and reports no credits", async () => {
    mockSignIn();
    const calls = fakeWallet({ code: 4902 });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    fireEvent.change(await screen.findByLabelText("Amount in test USDC"), { target: { value: "1.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay with test USDC" }));
    expect(await screen.findByRole("heading", { name: /test USDC received/ })).toBeTruthy();
    expect(screen.getByText(/no credits were added/)).toBeTruthy();
    expect(calls.some((call) => call.method === "wallet_addEthereumChain")).toBe(true);
    const sent = calls.find((call) => call.method === "eth_sendTransaction")!.params![0] as { to: string; data: string; value: string };
    expect(sent.to).toBe("0x3600000000000000000000000000000000000000");
    expect(sent.value).toBe("0x0");
    expect(BigInt(`0x${sent.data.slice(-64)}`)).toBe(1_500_000n);
  });

  it("explains a declined transfer, and sends nothing for a bad amount", async () => {
    mockSignIn();
    const calls = fakeWallet();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    fireEvent.change(await screen.findByLabelText("Amount in test USDC"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Pay with test USDC" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("valid amount"));
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
  });
});
