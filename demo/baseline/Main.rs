pub fn add(a: u32, b: u32) -> u32 {
    a + b
}

//! ```lean prelude
//! import Helper
//! ```

//! ```lean demo-check
//! #check helperValue
//! #check Nat.succ
//! ```

pub fn main() {
    let value = add(20, 22);
    println!("{value}");
}
