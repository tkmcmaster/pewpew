use crate::byte_utils;

use serde::Serialize;
use serde_json as json;
use std::cell::RefCell;

#[derive(Debug, PartialEq)]
pub struct Header {
    pub end: bool,
    pub id: u64,
    pub body_size: u16,
    pub op_code: u8,
}

impl Header {
    fn set_bits(&self, bytes: &mut [u8]) {
        // set the bits for the id
        let id = byte_utils::encode_u64(self.id << 1);
        (&mut bytes[..7]).copy_from_slice(&id[1..8]);
        // set the bits for the body size
        let body_size = byte_utils::encode_u16(self.body_size);
        (&mut bytes[7..9]).copy_from_slice(&body_size);
        // set the bit for "end"
        if self.end {
            bytes[6] |= 1;
        }
        // set the bits for op_code
        bytes[9] = self.op_code;
    }
}

const HEADER_SIZE: usize = 10;

#[derive(Default)]
pub struct HeaderBuffer {
    buffer: [u8; HEADER_SIZE],
    offset: usize,
}

impl HeaderBuffer {
    fn new(header: &Header) -> Self {
        let mut hb: Self = Default::default();
        hb.set_bits(header);
        hb
    }

    pub fn bytes_remaining(&self) -> bool {
        self.offset < HEADER_SIZE
    }

    pub fn next_section(&mut self) -> &mut [u8] {
        &mut self.buffer[self.offset..]
    }

    pub fn increment_offset(&mut self, n: usize) {
        self.offset += n;
    }

    pub fn to_header(&mut self) -> Header {
        // body size is two bytes at index 7
        let body_size = byte_utils::decode_u16(&self.buffer[7..9]);
        // the "finished" flag is the last bit of the 7th byte
        let end = self.buffer[6] & 1 == 1;
        // id is the first 55 bits
        let id = byte_utils::decode_u64(&self.buffer[..7]) >> 1;
        // op code is the final byte
        let op_code = self.buffer[9];
        self.offset = 0;
        Header {
            body_size,
            end,
            id,
            op_code,
        }
    }

    fn set_bits(&mut self, header: &Header) {
        header.set_bits(&mut self.buffer);
    }
}

pub struct BodyBuffer {
    buffer: Vec<u8>,
    offset: usize,
}

impl BodyBuffer {
    pub fn new(size: u16) -> Self {
        BodyBuffer {
            buffer: vec![0; size as usize],
            offset: 0,
        }
    }

    pub fn bytes_remaining(&self) -> bool {
        self.offset < self.buffer.capacity()
    }

    pub fn bytes(&self) -> &[u8] {
        &self.buffer
    }

    pub fn next_section(&mut self) -> &mut [u8] {
        &mut self.buffer[self.offset..]
    }

    pub fn increment_offset(&mut self, n: usize) {
        self.offset += n;
    }
}

#[derive(Debug)]
pub enum CallEndpointPreFunctionResult {
    Value(json::Value),
    Error(String),
    None,
}

#[derive(Debug)]
pub enum CreateFunctionResult {
    Id(u16),
    Error(String),
}

#[derive(Debug)]
pub enum IncomingResponse {
    CreateUtilFunction,
    CreateEndpointPreFunction(CreateFunctionResult),
    CreateEndpointPostFunction(CreateFunctionResult),
    CallEndpointPreFunction(CallEndpointPreFunctionResult),
    CallEndpointPostFunction(Option<String>),
}

#[derive(Debug)]
pub enum IncomingMessage {
    GetProviderValue(String),
    AddProviderValue(String, json::Value),
    LogMessage(String, json::Value),
    GetResponseBody(u64),
    IncomingResponse(IncomingResponse),
}

#[derive(Serialize)]
pub struct ResponseInit {
    headers: Vec<(String, String)>,
    status: u16,
}

pub enum OutgoingResponse {
    GetProviderValue(u64, json::Value),
    AddProviderValue(u64),
    LogMessage(u64),
    GetResponseBody(u64, Vec<u8>),
}

pub enum OutgoingMessage {
    CreateUtilFunction(String),
    CreateEndpointPreFunction(String),
    CreateEndpointPostFunction(String),
    CallEndpointPreFunction(u16),
    CallEndpointPostFunction(u16, ResponseInit),
    OutgoingResponse(OutgoingResponse),
}

thread_local! {
    static REQUEST_ID: RefCell<u64> = RefCell::new(0);
}

impl OutgoingMessage {
    pub fn encode(self) -> ([u8; HEADER_SIZE], Vec<u8>, u64) {
        let (op_code, body_bytes, id) = match self {
            OutgoingMessage::CreateUtilFunction(fn_sig) => {
                let id = REQUEST_ID.with(|r| {
                    *r.borrow_mut() += 1;
                    *r.borrow() - 1
                });
                (0, fn_sig.into_bytes(), id)
            }
            OutgoingMessage::CreateEndpointPreFunction(fn_body) => {
                let id = REQUEST_ID.with(|r| {
                    *r.borrow_mut() += 1;
                    *r.borrow() - 1
                });
                (1, fn_body.into_bytes(), id)
            }
            OutgoingMessage::CreateEndpointPostFunction(fn_body) => {
                let id = REQUEST_ID.with(|r| {
                    *r.borrow_mut() += 1;
                    *r.borrow() - 1
                });
                (2, fn_body.into_bytes(), id)
            }
            OutgoingMessage::CallEndpointPreFunction(fn_id) => {
                let id = REQUEST_ID.with(|r| {
                    *r.borrow_mut() += 1;
                    *r.borrow() - 1
                });
                (3, byte_utils::encode_u16(fn_id).into(), id)
            }
            OutgoingMessage::CallEndpointPostFunction(fn_id, response_init) => {
                let id = REQUEST_ID.with(|r| {
                    *r.borrow_mut() += 1;
                    *r.borrow() - 1
                });
                let mut body_bytes = Vec::with_capacity(256);
                let b = byte_utils::encode_u16(fn_id);
                body_bytes.extend_from_slice(&b);
                json::to_writer(&mut body_bytes, &response_init).expect("should serialize to json");
                (4, body_bytes, id)
            }
            OutgoingMessage::OutgoingResponse(r) => match r {
                OutgoingResponse::GetProviderValue(req_id, value) => {
                    let id = req_id;
                    let body_bytes = json::to_vec(&value).expect("should serialize to json");
                    (5, body_bytes, id)
                }
                OutgoingResponse::AddProviderValue(req_id) => {
                    let id = req_id;
                    (6, Vec::new(), id)
                }
                OutgoingResponse::LogMessage(req_id) => {
                    let id = req_id;
                    (7, Vec::new(), id)
                }
                OutgoingResponse::GetResponseBody(req_id, body_bytes) => {
                    let id = req_id;
                    (8, body_bytes, id)
                }
            },
        };
        if body_bytes.len() > u16::MAX as usize {
            todo!("handle case when body_bytes is longer than u16::MAX")
        }
        let header = Header {
            id,
            body_size: body_bytes.len() as u16,
            end: true,
            op_code,
        };
        let mut header_bytes = [0; HEADER_SIZE];
        header.set_bits(&mut header_bytes);
        (header_bytes, body_bytes, id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAX_SAFE_JS_INTEGER: u64 = 9007199254740991;
    #[test]
    fn to_from_header_bytes_works() {
        let headers = [
            Header {
                end: true,
                id: 4,
                body_size: 1891,
                op_code: 0,
            },
            Header {
                end: false,
                id: MAX_SAFE_JS_INTEGER,
                body_size: u16::MAX >> 1,
                op_code: 46,
            },
            Header {
                end: true,
                id: u64::from_str_radix(&"1".repeat(55), 2).unwrap(),
                body_size: 0,
                op_code: 255,
            },
        ];

        for header in &headers {
            let header2 = HeaderBuffer::new(header).to_header();
            assert_eq!(&header2, header, "headers should match");
        }
    }

    #[test]
    fn compatible_with_js_header_bytes() {
        let headers = [
            Header {
                end: true,
                id: 4,
                body_size: 1891,
                op_code: 0,
            },
            Header {
                end: false,
                id: MAX_SAFE_JS_INTEGER,
                body_size: u16::MAX >> 1,
                op_code: 46,
            },
            Header {
                end: true,
                id: u64::from_str_radix(&"1".repeat(55), 2).unwrap(),
                body_size: 0,
                op_code: 255,
            },
        ];

        let bytes = [
            [0u8, 0, 0, 0, 0, 0, 9, 7, 99, 0],
            [63, 255, 255, 255, 255, 255, 254, 127, 255, 46],
            [255, 255, 255, 255, 255, 255, 255, 0, 0, 255],
        ];

        for (header, bytes) in headers.iter().zip(&bytes) {
            let mut hb = HeaderBuffer {
                buffer: *bytes,
                offset: 0,
            };
            let header2 = hb.to_header();
            assert_eq!(&header2, header, "headers should match");
        }
    }
}
