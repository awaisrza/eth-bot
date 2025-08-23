#!/usr/bin/env node
const { ethers } = require("ethers");
const fs = require("fs");
const dotenv = require("dotenv");

dotenv.config({ path: __dirname + "/.env" });

// ✅ Load RPCs
if (!process.env.RPC_URLS) {
  console.error("❌ Missing RPC_URLS in .env (comma separated)");
  process.exit(1);
}
const RPC_URLS = process.env.RPC_URLS.split(",").map(u => u.trim()).filter(Boolean);
if (RPC_URLS.length === 0) {
  console.error("❌ No valid RPC URLs provided");
  process.exit(1);
}
const providers = RPC_URLS.map(url => new ethers.JsonRpcProvider(url));

// ✅ Load config
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;
const MINT_PRICE = process.env.MINT_PRICE;
const CALLDATA = process.env.CALLDATA;
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT || "300000");
const PRIORITY_GWEI = process.env.PRIORITY_GWEI || "10";
const BASEFEE_MULT = parseFloat(process.env.BASEFEE_MULT || "2");
const PURE_SPAM = process.env.PURE_SPAM === "true"; // always fire & forget

if (!CONTRACT_ADDRESS || !MINT_PRICE || !CALLDATA) {
  console.log("❌ CONTRACT_ADDRESS, MINT_PRICE, CALLDATA required in .env");
  process.exit(1);
}

// 🔑 Load wallets
const wallets = fs.readFileSync("wallets.txt", "utf-8")
  .split("\n")
  .map(l => l.trim())
  .filter(Boolean)
  .map(line => {
    const [pk, count] = line.split(",");
    return { pk, count: parseInt(count || "1", 10) };
  });

if (wallets.length === 0) {
  console.error("❌ No wallets found in wallets.txt");
  process.exit(1);
}

// ⚡ Fire & forget broadcast
function blastAllRPCs(rawTx) {
  providers.forEach((p, i) => {
    p.send("eth_sendRawTransaction", [rawTx])
      .then(hash => console.log(`RPC${i} ✅ ${hash}`))
      .catch(err => console.log(`RPC${i} ❌ ${err.message}`));
  });
}

// 🚀 Mint spammer
async function mintWithWallet({ pk, count }) {
  const wallet = new ethers.Wallet(pk);
  for (let i = 0; i < count; i++) {
    try {
      const provider = providers[Math.floor(Math.random() * providers.length)];
      const connected = wallet.connect(provider);

      const block = await provider.getBlock("latest");
      const base = block.baseFeePerGas || ethers.parseUnits("30", "gwei");
      const priority = ethers.parseUnits(PRIORITY_GWEI, "gwei");
      const maxFee = BigInt(Math.floor(Number(base) * BASEFEE_MULT)) + BigInt(priority.toString());
      const nonce = await provider.getTransactionCount(wallet.address, "pending");
      const network = await provider.getNetwork();

      const tx = {
        to: CONTRACT_ADDRESS,
        data: CALLDATA,
        value: ethers.parseEther(MINT_PRICE),
        gasLimit: GAS_LIMIT,
        maxFeePerGas: maxFee,
        maxPriorityFeePerGas: priority,
        nonce,
        chainId: Number(network.chainId),
      };

      const signedTx = await wallet.signTransaction(tx);

      console.log(`📤 ${wallet.address} -> blast attempt ${i + 1}`);
      blastAllRPCs(signedTx); // 🚀 instant fire & forget

      if (!PURE_SPAM) {
        // Wait for at least one confirmation if not in pure spam mode
        const sent = await provider.send("eth_sendRawTransaction", [signedTx]);
        console.log(`✅ ${wallet.address} confirmed hash: ${sent}`);
      }
    } catch (err) {
      console.error(`⚠️ ${wallet.address} mint attempt failed: ${err.message}`);
    }
  }
}

async function main() {
  console.log(`🔥 Starting spam mint from ${wallets.length} wallets across ${RPC_URLS.length} HTTP RPCs...`);
  for (let i = 0; i < providers.length; i++) {
    const net = await providers[i].getNetwork();
    console.log(`RPC${i} chainId = ${net.chainId}`);
  }

  await Promise.all(wallets.map(w => mintWithWallet(w)));
  console.log("🎉 Done blasting txns");
}

main();
