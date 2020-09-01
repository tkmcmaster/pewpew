mod byte_utils;
mod error;
mod message;

use byte_utils::decode_incoming_bytes;
use futures::{Stream, StreamExt};
use message::{CreateFunctionResult, Header, IncomingMessage, IncomingResponse, OutgoingMessage};
use tokio::{io::AsyncWriteExt, process};

use std::process::Stdio;

pub struct Demo {
    incoming: Box<dyn Stream<Item = Result<(Header, IncomingMessage), error::Error>> + Unpin>,
    outgoing: process::ChildStdin,
}

impl Demo {
    pub fn new() -> Self {
        let child = process::Command::new("deno/deno.exe")
            // .current_dir("./deno")
            .args(&["run", "deno/pewpew.ts"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let child_in = child.stdin.unwrap();
        let child_out = child.stdout.unwrap();

        let incoming = Box::new(decode_incoming_bytes(child_out));
        let outgoing = child_in;

        Self { incoming, outgoing }
    }

    pub async fn send_out_message(
        &mut self,
        outgoing_message: OutgoingMessage,
    ) -> IncomingResponse {
        let (header_bytes, body_bytes, request_id) = outgoing_message.encode();
        self.outgoing.write_all(&header_bytes).await.unwrap();
        self.outgoing.write_all(&body_bytes).await.unwrap();
        while let Some(Ok((header, incoming_message))) = self.incoming.next().await {
            if let (IncomingMessage::IncomingResponse(r), true) =
                (incoming_message, header.id == request_id)
            {
                return r;
            }
        }
        unreachable!("shouldn't happen");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn create_and_execute_js_function() {
        let mut demo = Demo::new();

        let create_function = OutgoingMessage::CreateEndpointPreFunction(
            r#"
            let mod = await import("./eval.ts");
            const a = [1, 2, 3];
            console.error("hello from Deno", a, mod);
            // let value = await providers.get("name");
            return { foo: 1234, bar: "abc" };
        "#
            .to_string(),
        );

        let fn_id = match demo.send_out_message(create_function).await {
            IncomingResponse::CreateEndpointPreFunction(CreateFunctionResult::Id(fn_id)) => fn_id,
            IncomingResponse::CreateEndpointPreFunction(CreateFunctionResult::Error(e)) => {
                panic!("{}", e);
            }
            _ => unreachable!(),
        };

        let call_function = OutgoingMessage::CallEndpointPreFunction(fn_id);
        let return_data = match demo.send_out_message(call_function).await {
            IncomingResponse::CallEndpointPreFunction(result) => result,
            _ => unreachable!(),
        };
        dbg!(return_data);
    }
}
