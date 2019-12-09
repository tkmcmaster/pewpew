extern crate proc_macro;

use crate::proc_macro::TokenStream;
use proc_macro2::Span;
use quote::quote;
use syn::{
    parse_quote, punctuated::Punctuated, Attribute, Data, GenericParam, Ident, Lit, Meta,
    NestedMeta, Token, Type, WhereClause,
};

use std::collections::BTreeMap;

#[proc_macro_derive(FromYaml, attributes(yaml))]
pub fn from_yaml_derive(input: TokenStream) -> TokenStream {
    // Construct a representation of Rust code as a syntax tree
    // that we can manipulate
    let ast = syn::parse(input).expect("invalid rust code");

    // Build the trait implementation
    impl_from_yaml_macro(&ast)
}

fn is_type_option(ty: &Type) -> bool {
    if let Some(v) = type_to_vec(ty) {
        v == ["Option"] || v == ["std", "option", "Option"] || v == ["core", "option", "Option"]
    } else {
        false
    }
}

fn type_to_vec(ty: &Type) -> Option<Vec<String>> {
    if let Type::Path(path) = ty {
        let segments: Vec<_> = path
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect();
        Some(segments)
    } else {
        None
    }
}

enum DefaultValue {
    None,
    Default,
    Func(String),
}

impl DefaultValue {
    fn is_default(&self) -> bool {
        if let DefaultValue::Default = &self {
            true
        } else {
            false
        }
    }
}

struct Attributes {
    default: DefaultValue,
    rename: Option<String>,
}

impl Attributes {
    fn new() -> Self {
        Attributes {
            default: DefaultValue::None,
            rename: None,
        }
    }
}

fn get_attrs(attrs: &[Attribute]) -> Attributes {
    let mut attributes = Attributes::new();
    for attr in attrs {
        if let Ok(Meta::List(list)) = attr.parse_meta() {
            let ident = list.path.get_ident().map(ToString::to_string);
            if let Some("yaml") = ident.as_ref().map(String::as_str) {
                for nested in list.nested.iter() {
                    match nested {
                        NestedMeta::Meta(Meta::NameValue(name_value)) => {
                            let ident = name_value.path.get_ident().map(ToString::to_string);
                            match (ident.as_ref().map(String::as_str), &name_value.lit) {
                                (Some("rename"), Lit::Str(s)) => {
                                    attributes.rename = Some(s.value());
                                    continue;
                                }
                                (Some("default"), Lit::Str(s)) => {
                                    attributes.default = DefaultValue::Func(s.value());
                                    continue;
                                }
                                _ => (),
                            }
                        }
                        NestedMeta::Meta(Meta::Path(path)) => {
                            let ident = path.get_ident().map(ToString::to_string);
                            if let Some("default") = ident.as_ref().map(String::as_str) {
                                attributes.default = DefaultValue::Default;
                                continue;
                            }
                        }
                        _ => (),
                    }
                    panic!("invalid value for yaml attribute")
                }
            }
        }
    }
    attributes
}

fn impl_from_yaml_macro(ast: &syn::DeriveInput) -> TokenStream {
    let name = &ast.ident;
    let generic_types: BTreeMap<_, _> = ast
        .generics
        .params
        .iter()
        .clone()
        .enumerate()
        .filter_map(|(i, p)| match p {
            GenericParam::Type(t) => Some((t.ident.to_string(), i)),
            _ => None,
        })
        .collect();
    let mut generic_fields = BTreeMap::new();
    let fields: Vec<_> = match &ast.data {
        Data::Struct(data_struct) => {
            data_struct.fields.iter()
                .enumerate()
                .map(|(i, field)| {
                    let name = field.ident
                        .clone()
                        .unwrap_or_else(|| Ident::new(&i.to_string(), Span::call_site()));
                    let mut rename = name.to_string(); 
                    let final_let = if is_type_option(&field.ty) {
                        None
                    } else {
                        let type_name = type_to_vec(&field.ty);
                        let attributes = get_attrs(&field.attrs);
                        if let Some(r) = attributes.rename {
                            rename = r;
                        }
                        let generic_index = type_name.and_then(|v| {
                            if v.len() == 1 {
                                generic_types.get(&v[0]).cloned()
                            } else {
                                None
                            }
                        });
                        if let Some(i) = generic_index {
                            generic_fields.insert(i, attributes.default.is_default());
                        }
                        let var = match attributes.default {
                            DefaultValue::Default => {
                                quote! {
                                    let #name = #name.unwrap_or_default();
                                }
                            }
                            DefaultValue::Func(func) => {
                                let func = Ident::new(&func, Span::call_site());
                                quote! {
                                    let #name = #name.unwrap_or_else(#func);
                                }
                            }
                            DefaultValue::None => {
                                let name_string = name.to_string();
                                quote! {
                                    let #name = #name.ok_or_else(|| Error::MissingYamlField(#name_string))?;
                                }
                            }
                        };
                        Some(var)
                    };
                    (name, final_let, rename)
                })
                .collect()
        },
        Data::Enum(_data_enum) => {
            unimplemented!()
        },
        Data::Union(_) => panic!("cannot derive `FromYaml` on a union")
    };

    let idents = fields.iter().map(|(ident, _, _)| ident);
    let matches = fields.iter().clone().map(|(ident, _, rename)| {
        let quoted = rename.to_string();
        quote! {
            #quoted => Keys::#ident
        }
    });
    let idents2 = idents.clone();
    let idents4 = idents.clone();
    let idents5 = idents.clone();
    let final_lets = fields.iter().filter_map(|(_, l, _)| l.as_ref());
    let generics = ast.generics.params.iter().clone();
    let generics2 = generics.clone().filter_map(|p| match p {
        GenericParam::Type(t) => {
            let ident = &t.ident;
            Some(quote! { #ident })
        }
        GenericParam::Lifetime(l) => {
            let lifetime = &l.lifetime;
            Some(quote! { #lifetime })
        }
        _ => None,
    });
    let where_clause = if !generic_fields.is_empty() {
        let mut wc = ast
            .generics
            .where_clause
            .clone()
            .unwrap_or_else(|| WhereClause {
                where_token: <Token![where]>::default(),
                predicates: Punctuated::new(),
            });
        for (i, default) in generic_fields {
            if let GenericParam::Type(t) = &ast.generics.params[i] {
                let ident = &t.ident;
                let qualifier = if default {
                    parse_quote! {
                        #ident: FromYaml<__I> + Default
                    }
                } else {
                    parse_quote! {
                        #ident: FromYaml<__I>
                    }
                };
                wc.predicates.push(qualifier);
            }
        }
        Some(wc)
    } else {
        ast.generics.where_clause.clone()
    };

    let expanded = quote! {
        impl<__I: Iterator<Item = char>, #(#generics),*> FromYaml<__I> for #name<#(#generics2),*>
            #where_clause
        {
            fn parse(
                __decoder: &mut YamlDecoder<__I>,
            ) -> Result<(Self, Marker), Error> {
                #(let mut #idents = None;)*
                let mut __saw_opening = false;

                #[allow(non_camel_case_types)]
                enum Keys { #(#idents2),* };

                impl Keys {
                    fn new(s: String) -> Result<Self, Error> {
                        let k = match s.as_str() {
                            #(#matches),*,
                            _ => return Err(Error::UnrecognizedKey(s))
                        };
                        Ok(k)
                    }
                }

                loop {
                    let (__event, __marker) = __decoder.next()?;
                    match __event {
                        YamlEvent::Scalar(__s, __scalar_style, __tag) => {
                            match Keys::new(__s)? {
                                #(Keys::#idents4 => #idents4 = Some(FromYaml::parse(__decoder)?)),*
                            }
                        }
                        YamlEvent::MappingStart | YamlEvent::SequenceStart => {
                            if __saw_opening {
                                return Err(Error::YamlDeserialize("unexpected start of yaml map or sequence", __marker))
                            }
                            __saw_opening = true;
                        }
                        YamlEvent::MappingEnd | YamlEvent::SequenceEnd => {
                            break;
                        }
                    }
                }
                #(#final_lets)*
                let ret = #name { #(#idents5),* };
                Ok((__marker, ret))
            }
        }
    };
    // panic!("{}", expanded);
    expanded.into()
}

// #[proc_macro_attribute]
// pub fn rename(_attr: TokenStream, _item: TokenStream) -> TokenStream {
//     unimplemented!()
// }
