import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockSignIn } from "../../lib/mockSession";
import { mockTopups } from "../../lib/mockTopups";
import { TopupRequestError } from "./topupClient";
import { TopupPage } from "./TopupPage";
import { parseAmount } from "./wallet";

vi.mock("../../lib/apiClient", async () => ({ api: (await import("../../lib/mockApi")).mockApi }));
vi.mock("../../lib/navigation", () => ({ leavePage: vi.fn() }));

const ADDRESS = "0x1111111111111111111111111111111111111111";

function mount(path = "/topup/?credits=40") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const root = createRootRoute({ component: TopupPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: [path] }) });
  return render(<QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider>);
}

function fakeWallet(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params?: unknown[] }[] = [];
  const answers: Record<string, unknown> = {
    eth_requestAccounts: [ADDRESS], personal_sign: "0xsigned", wallet_switchEthereumChain: null,
    eth_sendTransaction: `0x${"12".repeat(32)}`, eth_getTransactionReceipt: { status: "0x1" }, ...overrides,
  };
  (window as unknown as { ethereum: unknown }).ethereum = {
    request: async (call: { method: string; params?: unknown[] }) => {
      calls.push(call);
      const answer = answers[call.method];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return calls;
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as { ethereum?: unknown }).ethereum;
});

describe("Add credits page", () => {
  it("asks a signed-out visitor to sign in and keeps a card option", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Sign in to add credits" })).toBeTruthy();
  });

  it("says plainly when no wallet is installed, and still offers card plans", async () => {
    mockSignIn();
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("No browser wallet found"));
    expect(screen.getByRole("link", { name: "See monthly plans" })).toBeTruthy();
  });

  it("goes from the agent's shortfall through a quote and payment to credits added", async () => {
    mockSignIn();
    const calls = fakeWallet();
    mount();
    expect(await screen.findByText(/Your agent needs 40 credits more/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect wallet" }));
    fireEvent.change(await screen.findByLabelText(/^Amount/), { target: { value: "0.002" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a quote" }));
    expect(await screen.findByText(/About 333 credits, and at least 326 credits/)).toBeTruthy();
    expect(calls.some((call) => call.method === "personal_sign")).toBe(true);
    expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Pay" }));
    expect(await screen.findByRole("heading", { name: "333 credits added" })).toBeTruthy();
    expect(screen.getByText(/repeat its request now/)).toBeTruthy();
    await waitFor(() => expect(calls.some((call) => call.method === "eth_sendTransaction")).toBe(true));
  });

  it("never pays twice: if the server can't be reached after the wallet sent, it only checks again", async () => {
    mockSignIn();
    const calls = fakeWallet();
    const next = vi.spyOn(mockTopups, "next").mockRejectedValueOnce(new TopupRequestError("network_error"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    fireEvent.change(await screen.findByLabelText(/^Amount/), { target: { value: "0.002" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a quote" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pay" }));
    expect(await screen.findByText(/We couldn't confirm it just now/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pay" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("heading", { name: "333 credits added" })).toBeTruthy();
    const proof = { tx_hash: `0x${"12".repeat(32)}` };
    expect(next.mock.calls.map((call) => call[1])).toEqual([proof, proof]);
    expect(calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(1);
    next.mockRestore();
  });

  it("after a reload mid-payment, carries on from the saved proof without touching the wallet", async () => {
    mockSignIn();
    const calls = fakeWallet();
    window.localStorage.setItem("gtm-topup-in-flight", JSON.stringify({ id: "tp_mock", proof: { tx_hash: `0x${"12".repeat(32)}` } }));
    mount();
    expect(await screen.findByRole("heading", { name: "333 credits added" })).toBeTruthy();
    expect(calls.filter((call) => call.method === "eth_sendTransaction")).toHaveLength(0);
    expect(window.localStorage.getItem("gtm-topup-in-flight")).toBeNull();
  });

  it("reports a declined wallet request without moving on", async () => {
    mockSignIn();
    fakeWallet({ personal_sign: Object.assign(new Error("denied"), { code: 4001 }) });
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Connect wallet" }));
    fireEvent.change(await screen.findByLabelText(/^Amount/), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "Get a quote" }));
    expect(await screen.findByText(/You declined that in your wallet/)).toBeTruthy();
    expect(screen.queryByText(/You'll get/)).toBeNull();
  });
});

describe("parseAmount", () => {
  it("converts decimals exactly and refuses what it cannot represent", () => {
    expect(parseAmount("1.5", 6)).toBe("1500000");
    expect(parseAmount("0.000000000000000001", 18)).toBe("1");
    expect(parseAmount("1.1234567", 6)).toBeNull();
    expect(parseAmount("0", 6)).toBeNull();
    expect(parseAmount("1e5", 6)).toBeNull();
    expect(parseAmount("-1", 6)).toBeNull();
  });
});
