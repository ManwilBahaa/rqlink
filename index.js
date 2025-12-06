import { createClient, configure } from "./rqlink.js";
// Define a local schema for testing (includes standard PK and Composite Key)
const testSchema = {
  // Standard Table
  users: {
    port: 4001,
    primaryKey: "id",
    fields: {
      id: { type: "INTEGER", pk: true, autoIncrement: true },
      name: { type: "TEXT" },
      email: { type: "TEXT", notNull: true },
      age: { type: "REAL" }
    },
    indexes: [
      { name: "uq_users_email", columns: ["email"], unique: true }
    ]
  },
  // Composite Key Table (User Likes Post)
  likes: {
    port: 4001,
    // No single primaryKey
    fields: {
      user_id: { type: "INTEGER" },
      post_id: { type: "INTEGER" },
      created_at: { type: "TEXT", default: "CURRENT_TIMESTAMP" }
    },
    indexes: [
      { name: "uq_likes", columns: ["user_id", "post_id"], unique: true }
    ]
  }
};

// Configure client
configure({ verbose: true });

// Create the client instance
const { db, initDB, dropDB } = createClient(testSchema);

async function runTests() {
  console.log("--- STARTING RQLINK TESTS ---");

  // 1. CLEANUP & INIT
  console.log("\n[1] SETUP: Dropping & Re-initializing DB");
  await dropDB(); // Start fresh
  await initDB();

  // 2. CREATE (Standard)
  console.log("\n[2] TESTING CREATE (Standard)");
  const user1 = await db.users.create({
    data: { name: "Alice", email: "alice@example.com", age: 29 }
  });
  console.log("Created User:", user1);
  console.assert(user1.id === 1, "User ID mismatch");

  // 3. CREATE (Composite)
  console.log("\n[3] TESTING CREATE (Composite)");
  const like1 = await db.likes.create({
    data: { user_id: 1, post_id: 101 }
  });
  console.log("Created Like:", like1);
  console.assert(like1.user_id === 1 && like1.post_id === 101, "Like data mismatch");

  // 4. DUPLICATE CHECK (Composite)
  console.log("\n[4] TESTING DUPLICATE (Composite)");
  try {
    await db.likes.create({
      data: { user_id: 1, post_id: 101 }
    });
    console.error("!!! FAILED: Should have thrown error for duplicate like");
    process.exit(1);
  } catch (e) {
    console.log("Caught expected error:", e.message); // Should be UNIQUE constraint failed
  }

  // 5. READ (findMany with Filters)
  console.log("\n[5] TESTING READ (findMany)");
  await db.users.create({
    data: { name: "Bob", email: "bob@example.com", age: 30 }
  });
  const userss = await db.users.findMany();
  console.log(userss)
  console.log(`Found ${userss.length} users matching criteria`);
  console.assert(userss.length === 2, "Should find both Alice (name) and Bob (age)");

  // // 6. UPDATE (Standard PK)
  // console.log("\n[6] TESTING UPDATE (Standard PK)");
  // const updatedUser = await db.users.update({
  //   where: { id: 1 },
  //   data: { age: 26 }
  // });
  // console.log("Updated User:", updatedUser);
  // console.assert(updatedUser.age === 26, "Update failed");

  // // 7. UPDATE (Composite / No PK)
  // console.log("\n[7] TESTING UPDATE (Composite / No PK)");
  // // Update the like timestamp
  // // Since no PK, it will update based on WHERE and return the first match
  // const updatedLike = await db.likes.update({
  //   where: { user_id: 1, post_id: 101 },
  //   data: { created_at: "2025-01-01 00:00:00" }
  // });
  // console.log("Updated Like:", updatedLike);
  // console.assert(updatedLike.created_at === "2025-01-01 00:00:00", "Composite update failed");

  // // 8. DELETE
  // console.log("\n[8] TESTING DELETE");
  // await db.users.delete({ where: { id: 1 } });
  // const count = await db.users.count();
  // console.log("User Count:", count);
  // console.assert(count === 1, "Delete failed (should have 1 user left)");

  // // 9. MATH OPERATIONS
  // console.log("\n[9] TESTING MATH OPERATIONS");
  // // Setup: Create a product-like entry in users table for testing (reusing fields)
  // // Let's use 'age' as 'score' and 'is_active' as 'count' for this test
  // // We need to add a new user for this
  // const mathUser = await db.users.create({
  //   data: { name: "MathTest", email: "math@test.com", age: 100 } // age = score = 100
  // });

  // // 9a. Simple Math
  // console.log("-> Simple Math (age * 2)");
  // const simpleMath = await db.users.update({
  //   where: { email: "math@test.com" },
  //   data: {
  //     age: { math: "age * 2" }
  //   }
  // });
  // console.log("Result:", simpleMath);
  // console.assert(simpleMath.age === 200, "Simple math failed (100 * 2 != 200)");

  // // 9b. Complex Math (Moving Average Simulation)
  // // Let's pretend: age = avg_review, is_active (default 1) = number_of_reviews
  // // We want to add a new review of 5.
  // // Formula: (avg * count + new) / (count + 1)
  // // Current: avg=200, count=1 (default)
  // // New: (200 * 1 + 50) / (1 + 1) = 125  <-- let's use 50 as new rating to make numbers clear

  // // First ensure is_active is 1 (it is default)

  // console.log("-> Complex Math (Moving Average)");
  // const complexMath = await db.users.update({
  //   where: { email: "math@test.com" },
  //   data: {
  //     age: {
  //       math: "((age * (id +1)) + :new_val) / (:new_val + 1)",
  //       args: { new_val: 50 }
  //     }// Increment count at same time
  //   }
  // });
  // console.log("Result:", complexMath);
  // // Expected: age = (200 * 1 + 50) / 2 = 125
  // // Expected: is_active = 2
  // // console.assert(complexMath.age === 125, `Complex math failed. Expected 125, got ${complexMath.age}`);
  // // console.assert(complexMath.is_active === 2, "Increment failed in mixed update");

  console.log("\n--- ALL TESTS PASSED ---");
}

runTests().catch(e => {
  console.error("\n!!! TEST FAILED !!!");
  console.error(e);
  process.exit(1);
});