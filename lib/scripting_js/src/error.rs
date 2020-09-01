#[derive(Debug)]
pub enum Error {
    InvalidJsonBytes,
    InvalidUtf8Bytes,
    InvalidIncomingMessage(u8),
    StreamError,
}
