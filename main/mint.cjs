#!/usr/bin/env node
const { ethers } = require("ethers");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config({ path: __dirname + "/.env" });

const args = process.argv.slice(2);
if (args.length < 4) {
  console.log("Usage: node mint.js <contractAddress> <mintPriceETH> <calldata> <mintCount>");
  process.exit(1);
}

const [CONTRACT_ADDRESS, MINT_PRICE, CALLDATA, MINT_COUNT_STR] = args;
const MINT_COUNT = parseInt(MINT_COUNT_STR, 10);
if (!ethers.isAddress(CONTRACT_ADDRESS)) {
  console.error("❌ CONTRACT_ADDRESS is not a valid address");
  process.exit(1);
}
if (!Number.isFinite(Number(MINT_PRICE)) || Number(MINT_PRICE) < 0) {
  console.error("❌ MINT_PRICE must be a number in ETH (e.g. 0, 0.03)");
  process.exit(1);
}
if (!CALLDATA || !CALLDATA.startsWith("0x")) {
  console.error("❌ CALLDATA must be 0x-prefixed hex-encoded calldata");
  process.exit(1);
}
if (!Number.isInteger(MINT_COUNT) || MINT_COUNT <= 0) {
  console.error("❌ mintCount must be integer > 0");
  process.exit(1);
}

const rpcList = (process.env.RPC_URLS || process.env.RPC_URL || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

if (rpcList.length === 0) {
  console.error("❌ Provide at least one RPC via RPC_URLS or RPC_URL in .env");
  process.exit(1);
}

const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || "300000");         // keep lean to avoid estimateGas
const PRIORITY_GWEI = process.env.PRIORITY_GWEI || "10";            // tip
const BASEFEE_MULT = BigInt(process.env.BASEFEE_MULT || "2");       // baseFee multiplier

// Providers: one primary for chain data + a set for broadcast
const primary = new ethers.JsonRpcProvider(rpcList[0]);
const broadcasters = rpcList.map(u => new ethers.JsonRpcProvider(u));

// Load wallets
const wallets = fs
  .readFileSync(__dirname + "/wallets.txt", "utf-8")
  .split("\n")
  .map(v => v.trim())
  .filter(Boolean);

if (wallets.length === 0) {
  console.error("❌ wallets.txt is empty");
  process.exit(1);
}

async function getChainAndFees() {
  const net = await primary.getNetwork(); // { chainId }
  // Use pending block to get freshest baseFee
  const pendingBlock = await primary.getBlock("pending");
  if (!pendingBlock || pendingBlock.baseFeePerGas == null) {
    // fallback to feeData if baseFee missing
    const fd = await primary.getFeeData();
    const mf = fd.maxFeePerGas ?? ethers.parseUnits("60", "gwei");
    const mp = fd.maxPriorityFeePerGas ?? ethers.parseUnits(PRIORITY_GWEI, "gwei");
    return { chainId: Number(net.chainId), maxFeePerGas: mf, maxPriorityFeePerGas: mp };
  }

  const base = BigInt(pendingBlock.baseFeePerGas.toString());
  const priority = ethers.parseUnits(PRIORITY_GWEI, "gwei");
  // Simple heuristic: maxFee = base * multiplier + priority
  const maxFee = base * BASEFEE_MULT + BigInt(priority.toString());
  return { chainId: Number(net.chainId), maxFeePerGas: maxFee, maxPriorityFeePerGas: priority };
}

async function prebuildSignedTxsForWallet(pk, common) {
  const wallet = new ethers.Wallet(pk);
  const addr = wallet.address;

  // Fetch nonce from primary (pending) once
  let nonce = await primary.getTransactionCount(addr, "pending").catch(() => null);
  if (nonce == null) {
    throw new Error(`cannot fetch nonce for ${addr}`);
  }

  const value = ethers.parseEther(MINT_PRICE);

  // Build & sign N txs with sequential nonces (no signing at mint start)
  const signed = [];
  for (let i = 0; i < MINT_COUNT; i++) {
    const tx = {
      type: 2,
      chainId: common.chainId,
      to: CONTRACT_ADDRESS,
      data: CALLDATA,
      value,
      nonce: nonce + i,
      gasLimit: GAS_LIMIT,
      maxFeePerGas: common.maxFeePerGas,
      maxPriorityFeePerGas: common.maxPriorityFeePerGas,
    };
    const signedTx = await wallet.signTransaction(tx);
    signed.push({ addr, idx: i + 1, raw: signedTx });
  }

  return { addr, signed };
}

async function broadcastRawToAll(raw) {
  // Blast the same signed raw tx to all RPCs; don’t await one by one
  const sends = broadcasters.map(p =>
    p.broadcastTransaction(raw).catch(() => null)
  );

  // Resolve as soon as one succeeds; keep others fire-and-forget
  let first = null;
  try {
    first = await Promise.any(sends);
  } catch {
    // all rejected
  }
  return first; // may be undefined/null if all failed
}

async function main() {
  console.log(`🚀 Preparing ${MINT_COUNT} tx(s) per wallet for ${wallets.length} wallet(s)`);
  const common = await getChainAndFees();
  console.log(
    `⛽ chainId=${common.chainId}, gasLimit=${GAS_LIMIT.toString()}, maxPriority=${ethers.formatUnits(common.maxPriorityFeePerGas, "gwei")} gwei, maxFee≈${ethers.formatUnits(common.maxFeePerGas, "gwei")} gwei`
  );

  // Pre-sign all txs for all wallets (parallel)
  let bundles = await Promise.allSettled(wallets.map(pk => prebuildSignedTxsForWallet(pk, common)));
  bundles = bundles
    .map(r => (r.status === "fulfilled" ? r.value : null))
    .filter(Boolean);

  if (bundles.length === 0) {
    console.error("❌ No wallets could be prepared (nonce/sign failures)");
    process.exit(1);
  }

  // Flatten signed txs for blasting
  const signedAll = [];
  for (const b of bundles) {
    for (const s of b.signed) signedAll.push(s);
  }

  console.log(`🔥 Ready: ${signedAll.length} pre-signed txs. BLASTING…`);

  // Fire everything ASAP (parallel). Do NOT wait for confirmation.
  await Promise.all(
    signedAll.map(async ({ addr, idx, raw }) => {
      try {
        const resp = await broadcastRawToAll(raw);
        if (resp && resp.hash) {
          console.log(`✅ ${addr} [#${idx}] -> ${resp.hash}`);
        } else {
          console.log(`⚠️  ${addr} [#${idx}] -> broadcast failed on all RPCs`);
        }
      } catch (e) {
        console.log(`❌ ${addr} [#${idx}] broadcast error: ${e.message || e}`);
      }
    })
  );

  console.log("🎯 All signed transactions broadcasted.");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
