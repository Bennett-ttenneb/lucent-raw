use tract_onnx::prelude::*;
fn probe(p: &str, shapes: Vec<Vec<usize>>) {
    let m = tract_onnx::onnx().model_for_path(p).unwrap();
    let t = match m.into_typed() { Ok(t) => t, Err(e) => { println!("{p} typed: {}", format!("{e:?}").chars().take(300).collect::<String>()); return } };
    let r = match t.into_optimized() { Ok(r) => r, Err(e) => { println!("{p} optimize: {}", format!("{e:?}").chars().take(300).collect::<String>()); return } };
    println!("{p} optimized ok, inputs {}", r.input_outlets().unwrap().len());
    let run = r.into_runnable().unwrap();
    let inputs: TVec<TValue> = shapes.iter().enumerate().map(|(i, s)| {
        let dt = if p.contains("dec") && i == 1 { i64::datum_type() } else { f32::datum_type() };
        Tensor::zero_dt(dt, s).unwrap().into()
    }).collect();
    let t0 = std::time::Instant::now();
    let out = run.run(inputs).map_err(|e| format!("{e:?}"));
    println!("run: {:?} in {:?}", out.as_ref().map(|o| o.iter().map(|x| x.shape().to_vec()).collect::<Vec<_>>()).map_err(|e| e.chars().take(300).collect::<String>()), t0.elapsed());
}
fn main() {
    let d = std::env::args().nth(1).unwrap();
    probe(&format!("{d}/dec_fixed.onnx"), vec![vec![1,1,2,2], vec![1,1,2], vec![1,1,4], vec![1,32,256,256], vec![1,64,128,128], vec![1,256,64,64]]);
    probe(&format!("{d}/enc_fixed.onnx"), vec![vec![1,3,1024,1024]]);
}
