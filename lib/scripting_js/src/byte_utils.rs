use crate::error::Error;
use crate::message::{
    BodyBuffer, CallEndpointPreFunctionResult, CreateFunctionResult, Header, HeaderBuffer,
    IncomingMessage, IncomingResponse,
};

use futures::{stream, Stream};
use serde_json as json;
use tokio::io::AsyncRead;

use std::{pin::Pin, task::Poll};

pub fn decode_string(bytes: &[u8]) -> Result<&str, Error> {
    std::str::from_utf8(bytes).map_err(|_| Error::InvalidUtf8Bytes)
}

pub fn decode_u16(bytes: &[u8]) -> u16 {
    let mut array = [0u8; 2];
    copy_bytes_right_align(bytes, &mut array);
    u16::from_be_bytes(array)
}

pub fn encode_u16(n: u16) -> [u8; 2] {
    n.to_be_bytes()
}

pub fn decode_u64(bytes: &[u8]) -> u64 {
    let mut array = [0u8; 8];
    copy_bytes_right_align(bytes, &mut array);
    u64::from_be_bytes(array)
}

pub fn encode_u64(n: u64) -> [u8; 8] {
    n.to_be_bytes()
}

fn decode_json(bytes: &[u8]) -> Result<json::Value, Error> {
    // let str = decode_string(bytes)?;
    json::from_slice(bytes).map_err(|_e| Error::InvalidJsonBytes)
}

fn decode_incoming_msg(op_code: u8, body_bytes: &[u8]) -> Result<IncomingMessage, Error> {
    match op_code {
        0 => decode_string(body_bytes)
            .map(|s| IncomingMessage::GetProviderValue(s.to_string()))
            .map_err(|_| Error::InvalidIncomingMessage(op_code)),
        1 => {
            let json =
                decode_json(body_bytes).map_err(|_| Error::InvalidIncomingMessage(op_code))?;
            if let json::Value::Array(v) = json {
                let mut i = v.into_iter();
                if let (Some(json::Value::String(s)), Some(v), None) =
                    (i.next(), i.next(), i.next())
                {
                    return Ok(IncomingMessage::AddProviderValue(s, v));
                }
            }
            Err(Error::InvalidIncomingMessage(op_code))
        }
        2 => {
            let json =
                decode_json(body_bytes).map_err(|_| Error::InvalidIncomingMessage(op_code))?;
            if let json::Value::Array(v) = json {
                let mut i = v.into_iter();
                if let (Some(json::Value::String(s)), Some(v), None) =
                    (i.next(), i.next(), i.next())
                {
                    return Ok(IncomingMessage::LogMessage(s, v));
                }
            }
            Err(Error::InvalidIncomingMessage(op_code))
        }
        3 => {
            let response_id = decode_u64(body_bytes);
            Ok(IncomingMessage::GetResponseBody(response_id))
        }
        4 => Ok(IncomingMessage::IncomingResponse(
            IncomingResponse::CreateUtilFunction,
        )),
        5 => {
            let fn_result = match decode_json(body_bytes)? {
                json::Value::String(s) => CreateFunctionResult::Error(s),
                json::Value::Number(n) => match n.as_u64() {
                    Some(n) if n < u16::MAX as u64 => CreateFunctionResult::Id(n as u16),
                    _ => return Err(Error::InvalidJsonBytes),
                },
                _ => return Err(Error::InvalidJsonBytes),
            };
            Ok(IncomingMessage::IncomingResponse(
                IncomingResponse::CreateEndpointPreFunction(fn_result),
            ))
        }
        6 => {
            let fn_result = match decode_json(body_bytes)? {
                json::Value::String(s) => CreateFunctionResult::Error(s),
                json::Value::Number(n) => match n.as_u64() {
                    Some(n) if n < u16::MAX as u64 => CreateFunctionResult::Id(n as u16),
                    _ => return Err(Error::InvalidJsonBytes),
                },
                _ => return Err(Error::InvalidJsonBytes),
            };
            Ok(IncomingMessage::IncomingResponse(
                IncomingResponse::CreateEndpointPostFunction(fn_result),
            ))
        }
        7 => {
            let result = if body_bytes.is_empty() {
                CallEndpointPreFunctionResult::None
            } else {
                let json = decode_json(body_bytes);
                match json {
                    Ok(json::Value::String(s)) => CallEndpointPreFunctionResult::Error(s),
                    Ok(v) => CallEndpointPreFunctionResult::Value(v),
                    _ => return Err(Error::InvalidIncomingMessage(op_code)),
                }
            };
            Ok(IncomingMessage::IncomingResponse(
                IncomingResponse::CallEndpointPreFunction(result),
            ))
        }
        8 => {
            let error = if body_bytes.is_empty() {
                None
            } else {
                let error = decode_string(body_bytes)
                    .map_err(|_| Error::InvalidIncomingMessage(op_code))?;
                Some(error.to_string())
            };
            Ok(IncomingMessage::IncomingResponse(
                IncomingResponse::CallEndpointPostFunction(error),
            ))
        }
        _ => Err(Error::InvalidIncomingMessage(op_code)),
    }
}

fn copy_bytes_right_align(source: &[u8], target: &mut [u8]) {
    for (byte, target) in source.iter().rev().zip(target.iter_mut().rev()) {
        *target = *byte;
    }
}

pub fn decode_incoming_bytes<R: AsyncRead + Unpin>(
    mut input: R,
) -> impl Stream<Item = Result<(Header, IncomingMessage), Error>> {
    let mut header_buffer = HeaderBuffer::default();
    let mut body_buffer: Option<(Header, BodyBuffer)> = None;

    stream::poll_fn(move |cx| loop {
        match &mut body_buffer {
            Some((ref header, ref mut buf)) => {
                let buffer = buf.next_section();
                match Pin::new(&mut input).poll_read(cx, buffer) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(n)) if n == 0 && header.body_size != 0 => {
                        return Poll::Ready(None)
                    }
                    Poll::Ready(Ok(n)) => {
                        buf.increment_offset(n);
                        if !buf.bytes_remaining() {
                            let incoming_message =
                                match decode_incoming_msg(header.op_code, buf.bytes()) {
                                    Ok(i) => i,
                                    Err(e) => return Poll::Ready(Some(Err(e))),
                                };
                            let (header, _) = body_buffer.take().unwrap();
                            return Poll::Ready(Some(Ok((header, incoming_message))));
                        }
                    }
                    Poll::Ready(Err(_)) => return Poll::Ready(Some(Err(Error::StreamError))),
                }
            }
            None => {
                let buffer = header_buffer.next_section();
                match Pin::new(&mut input).poll_read(cx, buffer) {
                    Poll::Pending => return Poll::Pending,
                    Poll::Ready(Ok(n)) if n == 0 => return Poll::Ready(None),
                    Poll::Ready(Ok(n)) => {
                        header_buffer.increment_offset(n);
                        if !header_buffer.bytes_remaining() {
                            let header = header_buffer.to_header();
                            let body_size = header.body_size;
                            body_buffer = Some((header, BodyBuffer::new(body_size)));
                        }
                    }
                    Poll::Ready(Err(_)) => return Poll::Ready(Some(Err(Error::StreamError))),
                }
            }
        }
    })
}
