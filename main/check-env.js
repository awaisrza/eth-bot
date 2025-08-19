require("dotenv").config();
const { ethers } = require("ethers");

console.log("Raw PRIVATE_KEY:", process.env.PRIVATE_KEY);
console.log("Length:", process.env.PRIVATE_KEY?.length);

try {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log("✅ Wallet loaded successfully!");
  console.log("Address:", wallet.address);
} catch (err) {
  console.error("❌ Error loading wallet:", err.message);
}
